// src/sidepanel/ragClient.ts
export type RAGSource = { file_path?: string; title?: string; id?: string; score?: number };

const BASE_URL =  "http://127.0.0.1:5000";

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

export async function ragAsk(sessionId: string, question: string) {
  const res = await fetch(`${BASE_URL}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, question }),
  });
  if (!res.ok) throw new Error(`ask failed: ${res.status}`);
  return (await res.json()) as { answer: string; sources?: RAGSource[] };
}
