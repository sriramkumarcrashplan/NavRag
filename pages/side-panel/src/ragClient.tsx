// src/sidepanel/ragClient.ts
export type RAGSource = { file_path?: string; title?: string; id?: string; score?: number };

const BASE_URL =  "https://parablu-rag-chatbot.parablu.com";

export async function ragNewSession(): Promise<string> {
  const res = await fetch(`${BASE_URL}/new_chat_session`, { method: "POST" });
  if (!res.ok) throw new Error(`new_chat_session failed: ${res.status}`);
  const data = await res.json();
  return data.session_id as string;
}

export async function ragHistory(sessionId: string) {
  const res = await fetch(`${BASE_URL}/chat_history?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return [];
  return (await res.json()) as Array<{ role: "user" | "assistant"; content: string; sources?: RAGSource[] }>;
}

export async function ragAsk(sessionId: string, question: string): Promise<{ answer: string; sources?: RAGSource[] }> {
  const form = new FormData();
  form.append("session_id", sessionId);
  form.append("query", question);

  const res = await fetch(`${BASE_URL}/ask`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`ask failed: ${res.status}`);
  const data = await res.json();
  // **Make sure to return the parsed JSON**:
  return { answer: data.answer as string, sources: data.sources as RAGSource[] };
}
