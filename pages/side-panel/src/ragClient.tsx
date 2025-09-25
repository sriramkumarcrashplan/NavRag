import { Actors } from '@extension/storage';

export type RAGSource = { 
  file_path?: string; 
  title?: string; 
  id?: string; 
  score?: number; 
};

export type RAGResponse = {
  answer: string;
  sources?: RAGSource[];
};

export interface RAGEvent {
  actor: Actors;
  content: string;
  timestamp: number;
}

const BASE_URL = "https://parablu-rag-chatbot.parablu.com";

export async function ragNewSession(): Promise<string> {
  const res = await fetch(`${BASE_URL}/new_chat_session`, { method: "POST" });
  if (!res.ok) throw new Error(`new_chat_session failed: ${res.status}`);
  const data = await res.json();
  return data.session_id as string;
}

export async function ragHistory(sessionId: string) {
  const res = await fetch(`${BASE_URL}/chat_history?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return [];
  return (await res.json()) as Array<{ 
    role: "user" | "assistant"; 
    content: string; 
    sources?: RAGSource[] 
  }>;
}

// Enhanced RAG function that emits events like other agents
export async function ragAskWithEvents(
  sessionId: string, 
  question: string,
  onEvent?: (event: RAGEvent) => void
): Promise<RAGResponse> {
  
  // Emit start event like other agents
  onEvent?.({
    actor: Actors.RAG,
    content: 'Searching knowledge base...',
    timestamp: Date.now()
  });

  try {
    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("query", question);
    
    const res = await fetch(`${BASE_URL}/ask`, {
      method: "POST", 
      body: form,
    });
    
    if (!res.ok) {
      throw new Error(`RAG request failed: ${res.status}`);
    }
    
    const data = await res.json();
    const response = { 
      answer: data.answer as string, 
      sources: data.sources as RAGSource[] 
    };
    
    // Format sources for display
    const sourcesText = response.sources && response.sources.length
      ? `\n\nSources:\n` + response.sources
          .map((s, i) => `• ${s.file_path || s.title || s.id || `source ${i + 1}`}${typeof s.score === 'number' ? ` (score: ${s.score.toFixed(3)})` : ''}`)
          .join('\n')
      : "";
    
    // Emit success event with full response
    onEvent?.({
      actor: Actors.RAG,
      content: response.answer + sourcesText,
      timestamp: Date.now()
    });
    
    return response;
    
  } catch (error) {
    // Emit error event
    const errorMessage = error instanceof Error ? error.message : 'RAG query failed';
    
    onEvent?.({
      actor: Actors.RAG,
      content: `Error: ${errorMessage}`,
      timestamp: Date.now()
    });
    
    throw error;
  }
}

// Keep original function for backward compatibility
export async function ragAsk(sessionId: string, question: string): Promise<RAGResponse> {
  return ragAskWithEvents(sessionId, question);
}
