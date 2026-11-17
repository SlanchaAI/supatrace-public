// Shows the deployed commit in the footer when /build.json was stamped at publish time.
// An unstamped or missing marker leaves the footer unchanged.
const slot = document.getElementById('build');
if (slot) {
  fetch('/build.json', {cache: 'no-store'})
    .then(response => (response.ok ? response.json() : null))
    .then(build => {
      if (!build || typeof build.commit !== 'string' || !/^[0-9a-f]{40}$/.test(build.commit)) return;
      slot.textContent = 'Build ' + build.commit.slice(0, 7);
      slot.title = build.commit;
      slot.hidden = false;
    })
    .catch(() => {});
}
