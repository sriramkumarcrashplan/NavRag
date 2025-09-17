// background/agent/interactivity.ts
import { MessageService } from "./messages/service";
const awaitingInputMap = new Map<string, boolean>();

export class Interactivity {
  private static pending: Map<string, (answer: string) => void> = new Map();

  static async askUser(question: string, fieldId: string): Promise<string> {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${fieldId}`;
      this.pending.set(id, resolve);

      MessageService.sendToUI({
        type: "ask-user",
        id,
        field: fieldId,
        question,
      });
    });
  }

  static handleUserResponse(id: string, answer: string) {
    const resolver = this.pending.get(id);
    if (resolver) {
      resolver(answer);
      this.pending.delete(id);
    }
  }
  
}
