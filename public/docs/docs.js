// Adds a Copy button to every code block in the docs. No inline script or style.
for (const block of document.querySelectorAll('main pre')) {
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
