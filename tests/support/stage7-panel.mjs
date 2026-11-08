// Navigate the real panel on builds with areas. Historical flat panels do not need this step.
export async function openArea(panel, name) {
  const tab = await panel.$('::-p-aria(' + name + '[role="tab"])');
  if (!tab) return;
  if (await tab.evaluate((el) => el.getAttribute('aria-selected') === 'true')) return;
  await tab.click();
  await panel.waitForFunction(
    (label) =>
      [...document.querySelectorAll('[role=tab]')].some(
        (el) => el.textContent === label && el.getAttribute('aria-selected') === 'true',
      ),
    { timeout: 6000 },
    name,
  );
}
export async function openAdvanced(panel) {
  await openArea(panel, 'Settings');
  if (await panel.$('[role=tablist]')) await openDetails(panel, 'Advanced');
}

export async function openDetails(panel, label) {
  const summary = await panel.waitForSelector('summary::-p-text(' + label + ')', {
    visible: true,
    timeout: 6000,
  });
  const details = (await summary.evaluateHandle((el) => el.closest('details'))).asElement();
  if (!details) throw new Error('Missing disclosure for ' + label);
  if (!(await details.evaluate((el) => el.open))) {
    await summary.click();
    await panel.waitForFunction((el) => el.open, { timeout: 6000 }, details);
  }
  return details;
}
export async function guidedMode(panel, automatic) {
  const role = (label) => panel.locator('::-p-aria(' + label + '[role="button"])').setTimeout(8000);
  if (await panel.$('[role=tablist]')) {
    await openArea(panel, 'Guide');
    if (automatic) await role('Take me there').click();
    await role(automatic ? 'Start automatic' : 'Show me').click();
  } else await role(automatic ? 'Start automatic' : 'Guide me').click();
}
