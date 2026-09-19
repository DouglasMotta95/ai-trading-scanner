import { installationId } from '../services/telemetry.js';
import { storageLocalGet, storageLocalSet, storageLocalRemove, runtimeSendMessage, permissionsContains, permissionsRequest, tabsCreate } from '../services/chrome-compat.js';

(() => {
  if (globalThis.__ATS_ACCOUNT_LOGIN__) return;
  globalThis.__ATS_ACCOUNT_LOGIN__ = true;

  const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';
  const ACCOUNT_TOKEN_KEY = 'atsAccountToken';
  const ACCOUNT_EXP_KEY = 'atsAccountTokenExpiresAt';
  const LICENSE_KEY = 'atsLicenseKey';
  const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
  const CLIENT_TOKEN_KEY = 'atsClientToken';
  const CLIENT_EXP_KEY = 'atsClientTokenExpiresAt';
  const $ = s => document.querySelector(s);

  const base = () => PUBLIC_API;
  async function permission(url) {
    try {
      const origin = new URL(url).origin + '/*';
      const contained = await permissionsContains({ origins: [origin] });
      if (contained === undefined || contained === true) return true;
      const requested = await permissionsRequest({ origins: [origin] });
      return requested !== false;
    } catch {
      return false;
    }
  }

  async function clearAccountSession() {
    await storageLocalRemove([ACCOUNT_TOKEN_KEY, ACCOUNT_EXP_KEY]);
    const box = $('#accountAccessBox');
    box?.classList.remove('account-connected');
    const status = $('#accountConnectStatus');
    if (status) status.textContent = 'Sessão da conta expirada. Gere um novo código no portal ATS.';
  }

  async function saveSession(r) {
    const previous = await storageLocalGet([LICENSE_KEY, LAST_VALID_LICENSE_KEY]);
    const previousLicenseKey = String(previous[LICENSE_KEY] || previous[LAST_VALID_LICENSE_KEY]?.licenseKey || '').trim();
    const resolvedLicenseKey = String(r.licenseKey || r.license?.key || previousLicenseKey || '').trim();
    const values = {
      [CLIENT_TOKEN_KEY]: String(r.clientToken || ''),
      [CLIENT_EXP_KEY]: Number(r.clientTokenExpiresAt) || 0,
      [ACCOUNT_TOKEN_KEY]: String(r.accountToken || ''),
      [ACCOUNT_EXP_KEY]: Number(r.accountTokenExpiresAt) || 0
    };
    if (resolvedLicenseKey) values[LICENSE_KEY] = resolvedLicenseKey;
    if (r.license?.status === 'active') {
      values[LAST_VALID_LICENSE_KEY] = {
        license: { ...r.license, error: null, syncPending: false },
        licenseKey: resolvedLicenseKey,
        clientTokenExpiresAt: Number(r.clientTokenExpiresAt) || 0,
        validatedAt: Date.now()
      };
    }
    await storageLocalSet(values);
    await runtimeSendMessage({ type: 'ATS_VALIDATE_LICENSE' }).catch(() => {});
    return r;
  }

  async function exchange(code) {
    const url = base();
    if (!(await permission(url))) return { ok: false, error: 'permission_denied' };
    try {
      const r = await fetch(`${url}/v1/customer/extension/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: String(code || '').replace(/\D/g, ''),
          installationId: await installationId(),
          version: chrome.runtime.getManifest().version
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, status: r.status, ...d };
      return saveSession(d);
    } catch {
      return { ok: false, error: 'backend_unreachable' };
    }
  }

  async function refresh() {
    const x = await storageLocalGet([ACCOUNT_TOKEN_KEY, ACCOUNT_EXP_KEY]);
    const token = String(x[ACCOUNT_TOKEN_KEY] || '');
    if (!token) return false;
    if (Number(x[ACCOUNT_EXP_KEY] || 0) <= Date.now()) {
      await clearAccountSession();
      return false;
    }
    const url = base();
    try {
      const r = await fetch(`${url}/v1/customer/extension/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          installationId: await installationId(),
          version: chrome.runtime.getManifest().version
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401 || d?.error === 'account_token_invalid') await clearAccountSession();
        const status = $('#accountConnectStatus');
        if (status && (d?.error === 'license_expired' || d?.error === 'license_inactive')) status.textContent = 'Seu acesso está inativo ou vencido. Entre no portal para renovar.';
        return false;
      }
      await saveSession({
        ...d,
        accountToken: d.accountToken || token,
        accountTokenExpiresAt: d.accountTokenExpiresAt || x[ACCOUNT_EXP_KEY]
      });
      return true;
    } catch {
      const status = $('#accountConnectStatus');
      if (status) status.textContent = 'Sem comunicação com o servidor ATS. Tentaremos sincronizar novamente.';
      return false;
    }
  }

  function inject() {
    const card = $('#licenseCard');
    if (!card || $('#accountAccessBox')) return;

    const style = document.createElement('style');
    style.textContent = `
      .account-access{margin:14px 0;padding:16px;border:1px solid #244761;border-radius:16px;background:linear-gradient(145deg,#0b1a2b,#08131f)}
      .account-access-head{display:flex;justify-content:space-between;gap:12px;align-items:center}
      .account-access-head div{display:grid;gap:3px}
      .account-access-head b{font-size:14px}
      .account-access-head small{color:#88a4bc;line-height:1.35}
      .account-access-actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:12px}
      .account-access input{background:#07111d;border:1px solid #28475e;color:#fff;border-radius:11px;padding:13px;font-size:17px;font-weight:900;letter-spacing:.18em;text-align:center}
      .account-access button{border:0;border-radius:11px;padding:0 15px;background:linear-gradient(135deg,#4de2b7,#4a9dff);color:#031410;font-weight:950;cursor:pointer}
      .account-links{display:flex;justify-content:space-between;gap:8px;margin-top:10px}
      .account-links button{background:none;color:#77d8bd;padding:5px;font-size:11px}
      .account-status{display:block;color:#8fa8bf;font-size:11px;margin-top:9px;min-height:15px}
      .account-connected{border-color:#2b7963;background:#0c2924}
    `;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'accountAccessBox';
    box.className = 'account-access';
    box.innerHTML = `
      <div class="account-access-head">
        <div><b>ENTRAR NA MINHA CONTA</b><small>Gere um código no portal ATS e conecte esta instalação.</small></div>
        <span>🔐</span>
      </div>
      <div class="account-access-actions">
        <input id="accountConnectCode" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
        <button id="accountConnectBtn">CONECTAR</button>
      </div>
      <div class="account-links">
        <button id="openCustomerPortal">ABRIR PORTAL DO CLIENTE</button>
        <button id="manualKeyToggle">USAR CHAVE MANUAL</button>
      </div>
      <small id="accountConnectStatus" class="account-status">Você também pode usar uma chave manual quando precisar.</small>
    `;

    const activation = $('#activationBox');
    activation?.before(box);
    if (activation) {
      activation.dataset.accountManaged = '1';
      activation.dataset.manualOpen = '0';
      activation.hidden = true;
      $('#manualKeyToggle').textContent = 'USAR CHAVE MANUAL';
    }

    const codeInput = $('#accountConnectCode');
    codeInput?.addEventListener('input', () => {
      codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    });
    codeInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#accountConnectBtn')?.click();
    });

    $('#manualKeyToggle').onclick = () => {
      if (!activation) return;
      const open = activation.hidden;
      activation.dataset.manualOpen = open ? '1' : '0';
      activation.hidden = !open;
      $('#manualKeyToggle').textContent = open ? 'OCULTAR CHAVE MANUAL' : 'USAR CHAVE MANUAL';
      if (open) $('#licenseKey')?.focus();
    };

    $('#openCustomerPortal').onclick = () => tabsCreate({ url: `${base()}/` });

    $('#accountConnectBtn').onclick = async () => {
      const code = codeInput?.value || '';
      const status = $('#accountConnectStatus');
      const btn = $('#accountConnectBtn');
      if (code.replace(/\D/g, '').length !== 6) {
        status.textContent = 'Digite o código de 6 dígitos gerado no portal.';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'CONECTANDO...';
      status.textContent = 'Validando conta e vinculando este aparelho...';
      const r = await exchange(code);
      btn.disabled = false;
      btn.textContent = 'CONECTAR';

      if (r?.ok) {
        box.classList.add('account-connected');
        status.textContent = `Conta conectada • ${r.license?.planLabel || r.license?.plan || 'acesso ativo'}`;
        $('#licenseText').textContent = 'Conta vinculada e acesso sincronizado.';
        codeInput.value = '';
        if (activation) {
          activation.dataset.manualOpen = '0';
          activation.hidden = true;
          $('#manualKeyToggle').textContent = 'USAR CHAVE MANUAL';
        }
      } else {
        status.textContent = r?.error === 'connect_code_invalid'
          ? 'Código inválido ou expirado.'
          : r?.error === 'access_inactive'
            ? 'Seu acesso está inativo. Renove ou escolha um plano no portal.'
            : r?.error === 'trial_device_already_used'
              ? 'Este aparelho já utilizou um Trial em outra conta.'
              : r?.error === 'device_locked' || r?.error === 'device_limit_reached'
                ? 'Este acesso já está vinculado ao limite de aparelhos do plano.'
                : r?.error === 'permission_denied'
                  ? 'Permissão para conectar ao servidor ATS não foi concedida.'
                  : r?.error === 'backend_unreachable'
                    ? 'Servidor ATS indisponível. Tente novamente em alguns instantes.'
                    : 'Não foi possível conectar. Verifique o portal e tente novamente.';
      }
    };
  }

  inject();
  refresh().then(ok => {
    if (ok && $('#accountAccessBox')) {
      $('#accountAccessBox').classList.add('account-connected');
      $('#accountConnectStatus').textContent = 'Conta conectada • sincronização automática ativa.';
      const activation = $('#activationBox');
      if (activation) {
        activation.dataset.manualOpen = '0';
        activation.hidden = true;
        $('#manualKeyToggle').textContent = 'USAR CHAVE MANUAL';
      }
    }
  });
  setInterval(refresh, 60000);
  window.addEventListener('focus', refresh);
})();
