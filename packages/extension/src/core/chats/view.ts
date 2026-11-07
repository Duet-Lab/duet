export interface ChatRow { id: string; title: string; cwd: string; updatedAt: number; createdAt?: number | null }
export interface ProviderView {
    provider: 'claude' | 'codex'; sessions: ChatRow[]; complete: boolean; loading: boolean; warnings: string[]; total?: number;
}
export interface ChooserState {
    context: string;
    error: string;
    busy: boolean;
    status: string;
    providers: ProviderView[];
    recoveryDirectory?: string;
    pending: { operation: string; name: string; phase: string; canOpen?: boolean }[];
}
/** Short explanation stays next to the disabled action, not only in a distant banner. */
export function creationBlockedReason(state: ChooserState, provider: ProviderView): string {
    if (state.busy) { return 'Дождитесь завершения текущего действия или нажмите «Отмена».'; }
    if (provider.provider === 'claude') { return ''; }
    if (state.recoveryDirectory) { return 'Журнал восстановления недоступен. Откройте его папку и исправьте запись, затем нажмите «Обновить».'; }
    if (state.error) { return 'Сначала устраните ошибку, указанную выше, и нажмите «Обновить».'; }
    if (state.pending.length) { return 'Сначала откройте сохранённый чат или уберите незавершённую подготовку выше.'; }
    if (provider.loading) { return 'Подождите: загружаем и проверяем историю сессий.'; }
    if (!provider.complete) { return 'Подсчёт сессий неполон. Нажмите «Обновить»; подробности приведены ниже.'; }
    return '';
}

export function chatCreationLabel(createdAt: number | null | undefined, now = Date.now()): string {
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) { return 'Дата создания неизвестна'; }
    const elapsed = Math.max(0, now - createdAt);
    if (elapsed < 60000) { return 'Только что'; }
    if (elapsed < 3600000) { return new Intl.RelativeTimeFormat('ru-RU').format(-Math.floor(elapsed / 60000), 'minute'); }
    const date = new Date(createdAt), today = new Date(now);
    if (date.toDateString() === today.toDateString()) { return 'Сегодня'; }
    today.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) { return 'Вчера'; }
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** All user-controlled text arrives by postMessage and is inserted with textContent. */
export function chooserHtml(nonce: string): string {
    if (!/^[a-zA-Z0-9+/=]+$/.test(nonce)) { throw new Error('Некорректный ключ безопасности вкладки.'); }
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size)/1.5 var(--vscode-font-family)}main{max-width:1060px;margin:auto;padding:48px 36px}.intro{min-width:0}.context,.note,.warning,.error,.recovery,footer{overflow-wrap:anywhere}header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:36px}h1{font-weight:600;font-size:26px;margin:0 0 6px}h2{font-weight:600;font-size:18px;margin:0}p{margin:8px 0}.muted,.cwd,time{color:var(--vscode-descriptionForeground)}.context{display:block;margin-top:12px;font-size:13px}.providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(310px,100%),1fr));gap:24px}.provider{min-width:0;overflow:hidden;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:24px}.new{margin-top:20px;width:100%;font-weight:600}.label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:28px 0 10px}.rows{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;gap:4px}button{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:5px;padding:8px 13px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}.row{display:block;min-width:0;max-width:100%;overflow:hidden;text-align:left;color:var(--vscode-foreground);background:transparent;border:1px solid transparent;width:100%;padding:12px 9px}.row:hover{background:var(--vscode-list-hoverBackground)}.row-top{display:flex;min-width:0;width:100%;justify-content:space-between;gap:16px;align-items:baseline}.title{display:block;min-width:0;flex:1 1 0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cwd{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;margin-top:3px}time{flex:0 1 auto;min-width:0;max-width:48%;overflow:hidden;text-overflow:ellipsis;font-size:11px;white-space:nowrap}.note{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:12px}.warning,.error,.recovery{padding:12px 16px;margin:16px 0;border:1px solid var(--vscode-panel-border);border-radius:6px}.error{color:var(--vscode-errorForeground)}.warning{color:var(--vscode-editorWarning-foreground)}.progress{margin:20px 0;display:flex;align-items:center;justify-content:space-between;gap:12px}.empty{padding:48px 0;color:var(--vscode-descriptionForeground)}.recovery button{margin-right:8px;margin-top:8px}footer{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:24px}[hidden]{display:none!important}@media(max-width:550px){main{padding:24px 18px}header{flex-direction:column}.provider{padding:18px}}
</style></head><body><main id="root" aria-label="Выбор чата"></main><script nonce="${nonce}">
const api = acquireVsCodeApi();
const root = document.getElementById('root');
const creationBlockedReason = ${creationBlockedReason.toString()};
const creationLabel = ${chatCreationLabel.toString()};
function el(tag, text, cls) { const node = document.createElement(tag); if(text!==undefined) node.textContent=text; if(cls) node.className=cls; return node; }
function button(text, action, key, extra, disabled) { const node=el('button',text); node.type='button'; node.dataset.focus=key; node.disabled=!!disabled; node.addEventListener('click',()=>api.postMessage(Object.assign({action},extra||{}))); return node; }
function render(state) {
 const focused=document.hasFocus()&&document.activeElement&&document.activeElement.dataset.focus;
 const fragment=document.createDocumentFragment();
 const head=el('header'); const intro=el('div'); intro.className='intro';intro.append(el('h1','Новый чат'),el('div','Начните новый разговор или продолжите недавний.','muted'),el('span',state.context||'Текущее рабочее пространство','context')); head.append(intro,button('Обновить','refresh','refresh',null,state.busy)); fragment.append(head);
 if(state.error){const error=el('p',state.error,'error');error.setAttribute('role','alert');fragment.append(error);}
 if(state.recoveryDirectory){const recoveryFolder=button('Открыть папку журнала','recovery-folder','recovery-folder');recoveryFolder.className='secondary';fragment.append(recoveryFolder);}
 if(state.busy){const progress=el('div',undefined,'progress');const status=el('span',state.status||'Готовим чат…');status.setAttribute('role','status');progress.append(status,button('Отмена','cancel','cancel'));fragment.append(progress);}
 for(const pending of state.pending){const recovery=el('section',undefined,'recovery');recovery.append(el('strong',pending.name),el('p','Предыдущая подготовка не передана редактору. Откройте сохранённый чат или уберите только эту незавершённую подготовку.','note'),button('Открыть сохранённый чат','recover','recover-'+pending.operation,{operation:pending.operation},state.busy||!pending.canOpen),button('Убрать подготовку','discard','discard-'+pending.operation,{operation:pending.operation},state.busy));fragment.append(recovery);}
 if(!state.providers.length){fragment.append(el('p','Нет доступных расширений чата. Установите или включите Codex либо Claude Code, чтобы пользоваться чатами в этом окне.','empty'));}
 const columns=el('div',undefined,'providers');
 for(const provider of state.providers){
  const claude=provider.provider==='claude';const name=claude?'Claude':'Codex';const panel=el('section',undefined,'provider');panel.setAttribute('aria-label','Чаты '+name);panel.append(el('h2',name),el('p',claude?'Открытие чатов Claude пока не подключено. История доступна ниже.':'Новый разговор в текущем рабочем пространстве.','note'));
  const reason=creationBlockedReason(state,provider);const reasonId='new-reason-'+provider.provider;
  const create=button(claude?'Новая вкладка · пока недоступно':'Новая вкладка','new','new-'+provider.provider,{provider:provider.provider},!!reason);create.className='new';panel.append(create);
  if(reason){create.title=reason;create.setAttribute('aria-describedby',reasonId);const hint=el('p',reason,'note');hint.id=reasonId;hint.setAttribute('role','status');panel.append(hint);}
  if(!claude){panel.append(el('p','До открытия вкладки выполняется первое сообщение Codex с полным доступом к файлам, без запросов подтверждения.','note'));}
  panel.append(el('div','Последние сессии','label'));
  if(provider.loading){const loading=el('p','Загружаем локальную историю…','muted');loading.setAttribute('role','status');panel.append(loading);}
  for(const message of provider.warnings){panel.append(el('p',message,'warning'));}
  if(!provider.loading&&!provider.sessions.length){panel.append(el('p',provider.complete?'Подходящих сессий пока нет.':'Нет проверенных сессий для показа. Нажмите «Обновить», чтобы повторить.','muted'));}
  const rows=el('div',undefined,'rows');
  for(const session of provider.sessions){const row=button('','open','session-'+provider.provider+'-'+session.id,{provider:provider.provider,id:session.id},state.busy);row.className='row';row.title=session.title+'\\n'+session.cwd+(claude?'\\nОткрытие чатов Claude пока не подключено.':'');const top=el('span',undefined,'row-top');const time=el('time',creationLabel(session.createdAt));if(session.createdAt){time.title='Создан: '+new Date(session.createdAt).toLocaleString('ru-RU');time.dateTime=new Date(session.createdAt).toISOString();}top.append(el('span',session.title,'title'),time);row.append(top,el('span',session.cwd,'cwd'));rows.append(row);}
  panel.append(rows);if(provider.total>provider.sessions.length)panel.append(button('Показать ещё','more','more-'+provider.provider,{provider:provider.provider},state.busy));columns.append(panel);
 }
 fragment.append(columns,el('footer','Показываем чаты по первому запросу пользователя и рабочим директориям этого окна. Старые вкладки Codex могут называться «Codex», даже если имя в истории сохранено верно.'));
 root.replaceChildren(fragment);
 if(focused){const target=Array.from(root.querySelectorAll('button')).find(node=>node.dataset.focus===focused&&!node.disabled)||root.querySelector('[data-focus="cancel"]')||root.querySelector('[data-focus="new-codex"]:not([disabled])')||root.querySelector('button:not([disabled])');if(target)target.focus({preventScroll:true});}
}
window.addEventListener('message',event=>{if(event.data&&event.data.type==='state')render(event.data.state);});
api.postMessage({action:'ready'});
</script></body></html>`;
}
