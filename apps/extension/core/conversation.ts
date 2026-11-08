import {
  chatCharacters,
  privateText,
  type ChatConversation,
  type ChatTurn,
} from '@safestep/contracts';

export function emptyConversation(): ChatConversation {
  return { id: crypto.randomUUID(), turns: [], activeTurnId: null };
}

export function trimConversation(c: ChatConversation) {
  // The active turn stores its own original; pruning never edits an accepted task.
  let size = c.turns.reduce((sum, t) => sum + chatCharacters(t), 0);
  while (c.turns.length > 50 || size > 12000) {
    const index = c.turns.findIndex((t) => t.id !== c.activeTurnId);
    if (index < 0) break;
    size -= chatCharacters(c.turns[index]!);
    c.turns.splice(index, 1);
  }
}

export function routedHistory(
  c: ChatConversation,
  origin: string,
  doc: string,
  scope: string,
  omit: string,
) {
  const history: { role: 'user' | 'assistant'; text: string }[] = [];
  let used = 0;
  for (let i = c.turns.length - 1; i >= 0 && history.length < 6; i--) {
    const t = c.turns[i]!;
    if (
      t.id === omit ||
      t.id === c.activeTurnId ||
      t.origin !== origin ||
      t.documentId !== doc ||
      t.scope !== scope ||
      t.state === 'stale' ||
      !t.text ||
      privateText(t.text) ||
      used + t.text.length > 1600
    )
      continue;
    history.unshift({ role: t.role, text: t.text });
    used += t.text.length;
  }
  return history;
}

export function retireTurns(c: ChatConversation, state: 'stale' | 'paused' = 'stale') {
  for (const t of c.turns) {
    if (t.role === 'assistant' && !t.historical) {
      if (['working', 'routing', 'awaiting_user', 'preview_ready', 'clarifying'].includes(t.state))
        t.state = state;
      t.historical = true;
    }
  }
  c.activeTurnId = null;
}

export function makeTurn(
  role: ChatTurn['role'],
  text: string,
  origin: string | null,
  epoch: number,
  documentId: string | null,
): ChatTurn {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    state: role === 'user' ? 'completed' : 'routing',
    origin,
    epoch,
    documentId,
    historical: false,
  };
}
