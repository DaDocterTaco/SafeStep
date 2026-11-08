import {
  CompareAIInput,
  CompareAIReply,
  CompareInterpretation,
  CompareSelection,
  validatedComparisonAI,
  applyComparisonIntent,
  compareFacts,
  type CompareView,
  type CompareSettings,
} from '@safestep/contracts';
export async function comparisonAI(
  op: 'interpret' | 'explain',
  v: CompareView,
  signal: AbortSignal,
): Promise<{ settings?: CompareSettings; reasons: string[]; offerIds?: (string|null)[]; message: string }> {
  const common = {
    session: v.id,
    version: v.version,
    operationId: crypto.randomUUID(),
    bindingToken: crypto.randomUUID(),
  };
  const data = CompareAIInput.parse(
    op === 'interpret'
      ? { ...common, kind: 'intent', goal: v.settings.goal, settings: v.settings }
      : { ...common, kind: 'explain', facts: compareFacts(v) },
  );
  const token = (await chrome.storage.session.get('local-ai-session'))['local-ai-session'];
  if (typeof token !== 'string')
    throw Error('Gemini is not paired. The local comparison is available.');
  const response = await fetch('http://127.0.0.1:4317/v1/compare/' + data.kind, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(13000)]),
  });
  if (!response.ok)
    throw Error(
      response.status === 403
        ? 'Gemini pairing expired. Connect again.'
        : 'Comparison AI service unavailable.',
    );
  const raw = await response.text();
  if (raw.length > 8192) throw Error('Oversized AI reply.');
  const reply = CompareAIReply.parse(JSON.parse(raw));
  if (
    reply.session !== common.session ||
    reply.version !== common.version ||
    reply.operationId !== common.operationId ||
    reply.bindingToken !== common.bindingToken
  )
    throw Error('Stale comparison explanation.');
  if (reply.status !== 'available')
    throw Error(
      'Gemini · ' + reply.status.replaceAll('_', ' ') + '. Local comparison remains available.',
    );
  if (!validatedComparisonAI(reply.explanation, data))
    throw Error('Gemini returned an unsupported comparison.');
  if (data.kind === 'intent') {
    const d = CompareInterpretation.parse(reply.explanation);
    return d.question
      ? { reasons: [], message: d.question }
      : {
          settings: applyComparisonIntent(data.settings, d),
          message: 'Gemini interpreted your goal. Confirm the requirements before searching.',
          reasons: [],
        };
  }
  const d = CompareSelection.parse(reply.explanation);
  return {
    message: 'Gemini selected these current comparison facts.',
    reasons: d.selected.map((s) => data.facts.find((f) => f.id === s.fact)!.text),
    offerIds:d.selected.map(s=>s.candidate==='c0'?v.baseline?.id??null:v.candidates[Number(s.candidate.slice(1))-1]?.offer.id??null),
  };
}
