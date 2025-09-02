import { type BaseMessage, AIMessage, HumanMessage, type SystemMessage, ToolMessage } from '@langchain/core/messages';
import { MessageHistory, MessageMetadata } from '@src/background/agent/messages/views';
import { createLogger } from '@src/background/log';
import { wrapUserRequest } from '@src/background/agent/messages/utils';
import { Interactivity } from "../interactivity";

const logger = createLogger('MessageManager');

export class MessageManagerSettings {
  maxInputTokens = 128000;
  estimatedCharactersPerToken = 3;
  imageTokens = 800;
  includeAttributes: string[] = [];
  messageContext?: string;
  sensitiveData?: Record<string, string>;
  availableFilePaths?: string[];

  constructor(
    options: {
      maxInputTokens?: number;
      estimatedCharactersPerToken?: number;
      imageTokens?: number;
      includeAttributes?: string[];
      messageContext?: string;
      sensitiveData?: Record<string, string>;
      availableFilePaths?: string[];
    } = {},
  ) {
    if (options.maxInputTokens !== undefined) this.maxInputTokens = options.maxInputTokens;
    if (options.estimatedCharactersPerToken !== undefined)
      this.estimatedCharactersPerToken = options.estimatedCharactersPerToken;
    if (options.imageTokens !== undefined) this.imageTokens = options.imageTokens;
    if (options.includeAttributes !== undefined) this.includeAttributes = options.includeAttributes;
    if (options.messageContext !== undefined) this.messageContext = options.messageContext;
    if (options.sensitiveData !== undefined) this.sensitiveData = options.sensitiveData;
    if (options.availableFilePaths !== undefined) this.availableFilePaths = options.availableFilePaths;
  }
}

export default class MessageManager {
  private history: MessageHistory;
  private toolId: number;
  private settings: MessageManagerSettings;

  constructor(settings: MessageManagerSettings = new MessageManagerSettings()) {
    this.settings = settings;
    this.history = new MessageHistory();
    this.toolId = 1;
  }

  public initTaskMessages(systemMessage: SystemMessage, task: string, messageContext?: string): void {
    // Add system message
    this.addMessageWithTokens(systemMessage, 'init');

    // Add context message if provided
    if (messageContext && messageContext.length > 0) {
      const contextMessage = new HumanMessage({
        content: `Context for the task: ${messageContext}`,
      });
      this.addMessageWithTokens(contextMessage, 'init');
    }

    // Add task instructions
    const taskMessage = MessageManager.taskInstructions(task);
    this.addMessageWithTokens(taskMessage, 'init');

    // Add sensitive data info if sensitive data is provided
    if (this.settings.sensitiveData) {
      const info = `Here are placeholders for sensitive data: ${Object.keys(this.settings.sensitiveData)}`;
      const infoMessage = new HumanMessage({
        content: `${info}\nTo use them, write <secret>the placeholder name</secret>`,
      });
      this.addMessageWithTokens(infoMessage, 'init');
    }

    // Add example output
    const placeholderMessage = new HumanMessage({
      content: 'Example output:',
    });
    this.addMessageWithTokens(placeholderMessage, 'init');

    const toolCallId = this.nextToolId();
    const toolCalls = [
      {
        name: 'AgentOutput',
        args: {
          current_state: {
            evaluation_previous_goal:
              `Success - I successfully clicked on the 'Apple' link from the Google Search results page, 
              which directed me to the 'Apple' company homepage. This is a good start toward finding 
              the best place to buy a new iPhone as the Apple website often list iPhones for sale.`.trim(),
            memory: `I searched for 'iPhone retailers' on Google. From the Google Search results page, 
              I used the 'click_element' tool to click on a element labelled 'Best Buy' but calling 
              the tool did not direct me to a new page. I then used the 'click_element' tool to click 
              on a element labelled 'Apple' which redirected me to the 'Apple' company homepage. 
              Currently at step 3/15.`.trim(),
            next_goal: `Looking at reported structure of the current page, I can see the item '[127]<h3 iPhone/>' 
              in the content. I think this button will lead to more information and potentially prices 
              for iPhones. I'll click on the link to 'iPhone' at index [127] using the 'click_element' 
              tool and hope to see prices on the next page.`.trim(),
          },
          action: [{ click_element: { index: 127 } }],
        },
        id: String(toolCallId),
        type: 'tool_call' as const,
      },
    ];

    const exampleToolCall = new AIMessage({
      content: '',
      tool_calls: toolCalls,
    });
    this.addMessageWithTokens(exampleToolCall, 'init');
    this.addToolMessage('Browser started', toolCallId, 'init');

    // Add history start marker
    const historyStartMessage = new HumanMessage({
      content: '[Your task history memory starts here]',
    });
    this.addMessageWithTokens(historyStartMessage);

    // Add available file paths if provided
    if (this.settings.availableFilePaths && this.settings.availableFilePaths.length > 0) {
      const filepathsMsg = new HumanMessage({
        content: `Here are file paths you can use: ${this.settings.availableFilePaths}`,
      });
      this.addMessageWithTokens(filepathsMsg, 'init');
    }
  }

  public nextToolId(): number {
    const id = this.toolId;
    this.toolId += 1;
    return id;
  }

  private static taskInstructions(task: string): HumanMessage {
    const content = `Your ultimate task is: """${task}""". If you achieved your ultimate task, stop everything and use the done action in the next step to complete the task. If not, continue as usual.`;
    const wrappedContent = wrapUserRequest(content);
    return new HumanMessage({ content: wrappedContent });
  }

  public length(): number {
    return this.history.messages.length;
  }

  public addNewTask(newTask: string): void {
    const content = `Your new ultimate task is: """${newTask}""". This is a follow-up of the previous tasks. Make sure to take all of the previous context into account and finish your new ultimate task.`;
    const wrappedContent = wrapUserRequest(content);
    const msg = new HumanMessage({ content: wrappedContent });
    this.addMessageWithTokens(msg);
  }

  public addPlan(plan?: string, position?: number): void {
    if (plan) {
      const msg = new AIMessage({ content: `<plan>${plan}</plan>` });
      this.addMessageWithTokens(msg, null, position);
    }
  }

  public addStateMessage(stateMessage: HumanMessage): void {
    this.addMessageWithTokens(stateMessage);
  }

  public addModelOutput(modelOutput: Record<string, any>): void {
    const toolCallId = this.nextToolId();
    const toolCalls = [
      {
        name: 'AgentOutput',
        args: modelOutput,
        id: String(toolCallId),
        type: 'tool_call' as const,
      },
    ];

    const msg = new AIMessage({
      content: 'tool call',
      tool_calls: toolCalls,
    });
    this.addMessageWithTokens(msg);
    this.addToolMessage('tool call response', toolCallId);
  }

  public removeLastStateMessage(): void {
    this.history.removeLastStateMessage();
  }

  public getMessages(): BaseMessage[] {
    const messages = this.history.messages
      .filter(m => {
        if (!m.message) {
          console.error(`[MessageManager] Filtering out message with undefined message property:`, m);
          return false;
        }
        return true;
      })
      .map(m => m.message);

    let totalInputTokens = 0;
    logger.debug(`Messages in history: ${this.history.messages.length}:`);

    for (const m of this.history.messages) {
      totalInputTokens += m.metadata.tokens;
      if (m.message) {
        logger.debug(`${m.message.constructor.name} - Token count: ${m.metadata.tokens}`);
      } else {
        console.error(`[MessageManager] Found message with undefined message property:`, m);
        logger.debug(`Message with undefined message property - Token count: ${m.metadata.tokens}`);
      }
    }

    logger.debug(`Total input tokens: ${totalInputTokens}`);
    return messages;
  }

  public addMessageWithTokens(message: BaseMessage, messageType?: string | null, position?: number): void {
    let filteredMessage = message;
    if (this.settings.sensitiveData) {
      filteredMessage = this._filterSensitiveData(message);
    }

    const tokenCount = this._countTokens(filteredMessage);
    const metadata: MessageMetadata = new MessageMetadata(tokenCount, messageType);
    this.history.addMessage(filteredMessage, metadata, position);
  }

  private _filterSensitiveData(message: BaseMessage): BaseMessage {
    const replaceSensitive = (value: string): string => {
      let filteredValue = value;
      if (!this.settings.sensitiveData) return filteredValue;

      for (const [key, val] of Object.entries(this.settings.sensitiveData)) {
        if (!val) continue;
        filteredValue = filteredValue.replace(val, `<secret>${key}</secret>`);
      }
      return filteredValue;
    };

    if (typeof message.content === 'string') {
      message.content = replaceSensitive(message.content);
    } else if (Array.isArray(message.content)) {
      message.content = message.content.map(item => {
        if (typeof item === 'object' && item !== null && 'text' in item) {
          return { ...item, text: replaceSensitive(item.text) };
        }
        return item;
      });
    }

    return message;
  }

  private _countTokens(message: BaseMessage): number {
    let tokens = 0;

    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if ('image_url' in item) {
          tokens += this.settings.imageTokens;
        } else if (typeof item === 'object' && 'text' in item) {
          tokens += this._countTextTokens(item.text);
        }
      }
    } else {
      let msg = message.content;
      if ('tool_calls' in message) {
        msg += JSON.stringify(message.tool_calls);
      }
      tokens += this._countTextTokens(msg);
    }

    return tokens;
  }

  private _countTextTokens(text: string): number {
    return Math.floor(text.length / this.settings.estimatedCharactersPerToken);
  }

  public cutMessages(): void {
    let diff = this.history.totalTokens - this.settings.maxInputTokens;
    if (diff <= 0) return;

    const lastMsg = this.history.messages[this.history.messages.length - 1];

    if (Array.isArray(lastMsg.message.content)) {
      let text = '';
      lastMsg.message.content = lastMsg.message.content.filter(item => {
        if ('image_url' in item) {
          diff -= this.settings.imageTokens;
          lastMsg.metadata.tokens -= this.settings.imageTokens;
          this.history.totalTokens -= this.settings.imageTokens;
          logger.debug(
            `Removed image with ${this.settings.imageTokens} tokens - total tokens now: ${this.history.totalTokens}/${this.settings.maxInputTokens}`,
          );
          return false;
        }
        if ('text' in item) {
          text += item.text;
        }
        return true;
      });
      lastMsg.message.content = text;
      this.history.messages[this.history.messages.length - 1] = lastMsg;
    }

    if (diff <= 0) return;

    const proportionToRemove = diff / lastMsg.metadata.tokens;
    if (proportionToRemove > 0.99) {
      throw new Error(
        `Max token limit reached - history is too long - reduce the system prompt or task. proportion_to_remove: ${proportionToRemove}`,
      );
    }
    logger.debug(
      `Removing ${(proportionToRemove * 100).toFixed(2)}% of the last message (${(proportionToRemove * lastMsg.metadata.tokens).toFixed(2)} / ${lastMsg.metadata.tokens.toFixed(2)} tokens)`,
    );

    const content = lastMsg.message.content as string;
    const charactersToRemove = Math.floor(content.length * proportionToRemove);
    const newContent = content.slice(0, -charactersToRemove);

    this.history.removeLastStateMessage();

    const msg = new HumanMessage({ content: newContent });
    this.addMessageWithTokens(msg);

    const finalMsg = this.history.messages[this.history.messages.length - 1];
    logger.debug(
      `Added message with ${finalMsg.metadata.tokens} tokens - total tokens now: ${this.history.totalTokens}/${this.settings.maxInputTokens} - total messages: ${this.history.messages.length}`,
    );
  }

  public addToolMessage(content: string, toolCallId?: number, messageType?: string | null): void {
    const id = toolCallId ?? this.nextToolId();
    const msg = new ToolMessage({ content, tool_call_id: String(id) });
    this.addMessageWithTokens(msg, messageType);
  }
}

// -----------------------------------------------------------------------------
// NEW Chat + Interactivity Support Layer
// -----------------------------------------------------------------------------

export class MessageService {
  private static messageManager = new MessageManager(new MessageManagerSettings());

  static init() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "user-response") {
        Interactivity.handleUserResponse(msg.id, msg.answer);
        this.messageManager.addMessageWithTokens(new HumanMessage({ content: msg.answer }));
        this.sendToUI({ type: "chat-update", role: "user", text: msg.answer });
      }

      if (msg.type === "user-task") {
        logger.info("New user task:", msg.text);
        this.messageManager.addNewTask(msg.text);

        chrome.runtime.sendMessage({
          type: "start-task",
          task: msg.text,
        });

        this.sendToUI({ type: "chat-update", role: "user", text: msg.text });
      }
    });
  }

  static sendToUI(payload: any) {
    chrome.runtime.sendMessage(payload);
  }

  static sendAgentMessage(text: string) {
    this.sendToUI({ type: "chat-update", role: "agent", text });
  }
}
