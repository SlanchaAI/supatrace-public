// Adds a Copy button to every code block in the docs. No inline script or style.
for (const block of document.querySelectorAll('main pre')) {
  block.tabIndex = 0;
  block.setAttribute('role', 'region');
  block.setAttribute('aria-label', 'Code example; scroll horizontally for more');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(block.querySelector('code').textContent + '\n');
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  });
  const frame = document.createElement('div');
  frame.className = 'snippet';
  block.before(frame);
  frame.append(button, block);
}

// Tables keep their own scroll area and a keyboard target at narrow widths.
for (const [index, table] of [...document.querySelectorAll('main table')].entries()) {
  const frame = table.parentElement.classList.contains('table-scroll') ? table.parentElement : document.createElement('div');
  if (frame !== table.parentElement) { table.before(frame); frame.append(table); }
  frame.classList.add('table-scroll');
  frame.tabIndex = 0;
  frame.setAttribute('role', 'region');
  frame.setAttribute('aria-label', `Documentation table ${index + 1}; scroll horizontally for more`);
}
