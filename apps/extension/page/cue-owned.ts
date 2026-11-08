const cueNodes = '[data-safestep-outline],[data-safestep-instruction],[data-safestep-dock]';
const descriptions = new WeakMap<Element, string | null>();

export function writeCueDescription(target: HTMLElement, value: string | null) {
  descriptions.set(target, value);
  if (value === null) target.removeAttribute('aria-describedby');
  else target.setAttribute('aria-describedby', value);
}

/** Ignore extension presentation only. Site edits to its own descriptions or controls remain observable. */
export function cueMutation(record: MutationRecord) {
  const el = record.target instanceof Element ? record.target : record.target.parentElement;
  if (el?.closest(cueNodes)) return true;
  if (
    el &&
    record.type === 'attributes' &&
    record.attributeName === 'aria-describedby' &&
    descriptions.has(el) &&
    descriptions.get(el) === el.getAttribute('aria-describedby')
  )
    return true;
  return (
    record.type === 'childList' &&
    [...record.addedNodes, ...record.removedNodes].every(
      (n) => n instanceof Element && n.matches(cueNodes),
    )
  );
}
