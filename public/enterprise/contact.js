// Contact sales without a backend: compose an email draft in the visitor's own mail client.
// Nothing is sent to SupaTrace by this page.
const form = document.getElementById('sales-form');
if (form) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = name => String(new FormData(form).get(name) || '').trim();
    const lines = ['Name: ' + value('name'), 'Work email: ' + value('email'), 'Company: ' + value('company'), 'Team size: ' + value('size'), '', value('message')];
    const link = 'mailto:' + form.dataset.to + '?subject=' + encodeURIComponent('SupaTrace Enterprise: ' + value('company')) + '&body=' + encodeURIComponent(lines.join('\n'));
    document.getElementById('sales-status').textContent = 'Opening a draft in your mail client. If nothing opens, write to ' + form.dataset.to + '.';
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  // The button ships disabled so a failed script load can never submit the fields as a GET.
  form.querySelector('button[type=submit]').disabled = false;
}
