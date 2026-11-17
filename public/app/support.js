// Uses the same scoped API and server entitlements as the rest of Settings.
export async function mountSupport({document, request}) {
  const settings = document.querySelector('#view-settings .settings');
  if (!settings || document.getElementById('support-section')) return;
  const section = document.createElement('div'); section.className = 'setting'; section.id = 'support-section';
  section.innerHTML = '<h2>Support</h2><p><a href="/docs/">Docs</a> · <a href="/status/">Status</a> · <a href="mailto:support@supatrace.dev">Email support</a></p><p id="support-plan"></p><p>Send a question and include your workspace and project. Do not paste API keys, login details, or private traces. We reply to the address you enter.</p><form id="support-form"><label>Email<input name="email" type="email" maxlength="254" required></label><label>Subject<input name="subject" maxlength="120" required></label><label>Message<textarea name="message" maxlength="2500" required></textarea></label><label id="support-priority"><input name="priority" type="checkbox">Priority routing (Pro)</label><label id="support-contract"><input name="contract" type="checkbox">Contract support (Enterprise; response terms by agreement)</label><button type="submit">Send request</button></form><p id="support-result" role="status" aria-live="polite"></p>';
  settings.append(section);
  const form = section.querySelector('form'), status = section.querySelector('#support-result');
  let available = false;
  const paint = info => {
    section.querySelector('#support-plan').textContent = info.plan_name + ' support';
    for (const [name, flag] of [['priority', 'priority_support'], ['contract', 'sla']]) {
      const input = form.elements[name]; input.disabled = info.features[flag]?.enabled !== true;
      if (input.disabled) input.checked = false;
    }
    form.inert = !available || info.features.email_support?.enabled !== true;
    status.textContent = form.inert ? (available ? 'This support form needs Base or higher. Upgrade in Billing, or email support@supatrace.dev.' : 'Email support is unavailable. Contact support@supatrace.dev.') : '';
  };
  document.addEventListener('supatrace:entitlements', event => paint(event.detail));
  const failed = error => {status.textContent = error?.status === 429 ? 'Support request limit reached. Try later.' : 'Delivery was not confirmed. Contact support@supatrace.dev with your question.';};
  try {
    const info = await request('support'); available = info.available; paint(info);
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; status.textContent = 'Sending support request…';
      try {const data = Object.fromEntries(new FormData(form)); data.priority = form.elements.priority.checked; data.contract = form.elements.contract.checked;
        const result = await request('support', data); status.textContent = 'Delivered to ' + result.route + ' support. Reference: ' + result.id; form.elements.message.value = '';
      } catch (error) {failed(error);} finally {button.disabled = false;}
    };
  } catch (error) {form.inert = true; failed(error);}
}
