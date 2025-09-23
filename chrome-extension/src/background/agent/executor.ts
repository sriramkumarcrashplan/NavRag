import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry, NavigatorResult } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
} from './agents/errors';
import { wrapUntrustedContent } from './messages/utils';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  private executedTasks: Set<string> = new Set();
  private isExecuting: boolean = false;
  
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();
    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    // Prevent duplicate tasks
    const taskHash = this.generateTaskHash(task);
    if (this.executedTasks.has(taskHash)) {
      logger.info(`Task already executed, skipping: ${task}`);
      return;
    }
    
    // Check if task is already in queue
    if (this.tasks.includes(task)) {
      logger.info(`Task already in queue, skipping: ${task}`);
      return;
    }
    
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }
  
  private generateTaskHash(task: string): string {
  const normalizedTask = task.toLowerCase().trim();
  let hash = 0;
  
  if (normalizedTask.length === 0) return '0';
  
  for (let i = 0; i < normalizedTask.length; i++) {
    const char = normalizedTask.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  return Math.abs(hash).toString(36);
}
  
  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();

      if (planOutput.result) {
        // Store plan in message history
        const observation = wrapUntrustedContent(planOutput.result.observation);
        const plan: PlannerOutput = {
          ...planOutput.result,
          observation,
        };
        this.context.messageManager.addPlan(JSON.stringify(plan), positionForPlan);
      }

      return planOutput;
    } catch (error) {
      logger.error('Planner execution failed:', error);
      return null;
    }
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<AgentOutput<NavigatorResult>> {
    // Prevent concurrent executions
    if (this.isExecuting) {
      logger.info('Execution already in progress, skipping');
      return { id: 'executor', result: { done: true } };
    }
    
    this.isExecuting = true;
    
    try {
      const currentTask = this.tasks[this.tasks.length - 1];
      const taskHash = this.generateTaskHash(currentTask);
      
      // Check if task was already executed
      if (this.executedTasks.has(taskHash)) {
        logger.info('Task already executed, returning previous result');
        return { id: 'executor', result: { done: true } };
      }
      
      logger.info(`🚀 Executing task: ${currentTask}`);
      this.context.nSteps = 0;
      
      // Mark task as being executed
      this.executedTasks.add(taskHash);
      
      // Rest of execute method...
      const allowedMaxSteps = this.context.options.maxSteps;
      
      try {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);
        
        // Check completion at start
        if (this.isTaskAlreadyCompleted()) {
          logger.info('✅ Task already completed at start');
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, 
            this.context.finalAnswer || this.context.taskId);
          return { id: 'executor', result: { done: true } };
        }
        
        let step = 0;
        let latestPlanOutput: AgentOutput<any> | null = null;
        let navigatorDone = false;
        
        for (step = 0; step < allowedMaxSteps; step++) {
          this.context.stepInfo = {
            stepNumber: this.context.nSteps,
            maxSteps: this.context.options.maxSteps,
          };
          
          logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
          
          if (await this.shouldStop()) break;
          
          // Double-check completion before each step
          if (this.isTaskAlreadyCompleted()) {
            logger.info('✅ Task completed during execution');
            break;
          }
          
          // Run planner periodically
          if (this.planner && (this.context.nSteps % this.context.options.planningInterval === 0 || navigatorDone)) {
            navigatorDone = false;
            latestPlanOutput = await this.runPlanner();
            
            if (this.checkTaskCompletion(latestPlanOutput)) {
              break;
            }
          }
          
          // Execute navigator
          navigatorDone = await this.navigate();
          
          if (navigatorDone) {
            logger.info('🔄 Navigator indicates completion');
          }
        }
        
        // Determine final result
        const isCompleted = latestPlanOutput?.result?.done === true;
        
        if (isCompleted) {
          const finalMessage = this.context.finalAnswer || this.context.taskId;
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);
          return { id: 'executor', result: { done: true } };
        } else if (step >= allowedMaxSteps) {
          logger.error('❌ Task failed: Max steps reached');
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));
          return { id: 'executor', error: 'Max steps reached' };
        } else if (this.context.stopped) {
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
          return { id: 'executor', result: { done: false } };
        } else {
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
          return { id: 'executor', result: { done: false } };
        }
        
      } catch (error) {
        // Remove from executed set if execution failed
        this.executedTasks.delete(taskHash);
        
        if (error instanceof RequestCancelledError) {
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
        } else {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));
        }
        throw error;
      } finally {
        // Store history logic...
        if (import.meta.env.DEV) {
          logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
        }
        
        if (this.generalSettings?.replayHistoricalTasks) {
          const historyString = JSON.stringify(this.context.history);
          logger.info(`Executor history size: ${historyString.length}`);
          await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
        }
      }
      
    } finally {
      this.isExecuting = false;
    }
  }


  private isTaskAlreadyCompleted(): boolean {
    // Enhanced completion check
    const hasCompletionResult = this.context.actionResults.some(result => 
      result.isDone || 
      (result.extractedContent && result.extractedContent.toLowerCase().includes('complete')) ||
      (result.extractedContent && result.extractedContent.toLowerCase().includes('finished')) ||
      (result.extractedContent && result.extractedContent.toLowerCase().includes('done'))
    );
    
    const hasFinalAnswer = !!this.context.finalAnswer;
    const isMarkedComplete = this.context.taskCompleted;
    
    return hasCompletionResult || hasFinalAnswer || isMarkedComplete;
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new Error(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }

  static async run(action: string, params: any) {
    if (action === "input") {
      chrome.scripting.executeScript({
        target: { tabId: params.tabId },
        func: (xpath: string, value: string) => {
          const el = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue as HTMLElement;

          if (el) {
            (el as HTMLInputElement).value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        },
        args: [params.xpath, params.value],
      });
    }

    if (action === "click") {
      chrome.scripting.executeScript({
        target: { tabId: params.tabId },
        func: (xpath: string) => {
          const el = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue as HTMLElement;
          if (el) (el as HTMLElement).click();
        },
        args: [params.xpath],
      });
    }
  }

  async resumeAfterUserInput(userResponse: string): Promise<void> {
  const logger = createLogger('Executor:resumeAfterUserInput');
  
  if (this.context.waitingForUserInput) {
    logger.info(`📝 User responded: ${userResponse}`);
    
    // Handle the user response
    await this.context.handleUserResponse(userResponse);
    
    // Continue execution from where we left off
    logger.info('🔄 Resuming execution after user input');
    await this.execute();
  } else {
    logger.warning('Received user response but not waiting for input');
  }
  }
}
