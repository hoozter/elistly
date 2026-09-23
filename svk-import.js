/* Signed-in, read-only folder selection. Source files are never modified. */
(function () {
  'use strict';
  const make = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function button(text, action) {
    const el = make('button', text, 'btn btn-secondary'); el.type = 'button'; el.onclick = action; return el;
  }
  function dialog(app, id, title) {
    document.getElementById(id)?.remove();
    const modal = make('div', undefined, 'modal svk-import-modal'); modal.id = id;
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', title);
    const content = make('div', undefined, 'modal-content');
    const header = make('div', undefined, 'modal-header'); header.append(make('h3', title));
    const body = make('div', undefined, 'modal-body');
    const actions = make('div', undefined, 'modal-actions');
    actions.append(button('Close', () => app.closeModal(id)));
    content.append(header, body, actions); modal.append(content); document.body.append(modal); app.showModal(id);
    return {modal, body, actions};
  }
  async function open(app, request, storage, session) {
    if (!session?.user?.id || !session.access_token) return app.showNotification('Sign in before importing inventory.', 'error');
    if (storage._isDirty || storage._readOutbox(session.user.id).length) return app.showNotification('Sync or resolve pending edits before importing inventory.', 'error');
    const {modal, body, actions} = dialog(app, 'svkImportModal', 'Import inventory from folder');
    const generation = storage._accountGeneration;
    const active = () => modal.isConnected && modal.classList.contains('show') && storage._accountGeneration === generation;
    const api = (path, options = {}) => request(path, {...options, authSession:session});
    const workspace = make('select'); workspace.id = 'svkWorkspace';
    const label = make('label', 'Workspace'); label.htmlFor = workspace.id;
    const status = make('p', 'Loading authorized workspaces…', 'help-text'); status.setAttribute('role', 'status');
    body.append(make('p', 'Choose the DEPLOYDATA inventory folder or select report files. Review the preview, then import all eligible reports. Files stay on your USB; archive or delete them manually only after they appear in the safe list. If you close during import, select the files again to confirm their results.'), label, workspace);
    const inputs = make('div', undefined, 'svk-file-inputs');
    const folder = make('input'); folder.type = 'file'; folder.multiple = true; folder.setAttribute('webkitdirectory', ''); folder.id = 'svkFolder';
    const files = make('input'); files.type = 'file'; files.multiple = true; files.id = 'svkFiles';
    const folderLabel = make('label', 'Choose folder'); folderLabel.htmlFor = folder.id;
    const filesLabel = make('label', 'Or choose multiple files'); filesLabel.htmlFor = files.id;
    inputs.append(folderLabel, folder, filesLabel, files);
    const previewList = make('ul', undefined, 'svk-file-list'); previewList.id = 'svkPreview';
    const safe = make('ul', undefined, 'svk-file-list'); safe.id = 'svkSafe';
    const attention = make('ul', undefined, 'svk-file-list'); attention.id = 'svkAttention';
    body.append(inputs, make('p', 'Up to 100 files, 4 MiB total, 64 KiB per report, and 8 folder levels. Incomplete .pending files are ignored and remain in Needs attention.', 'help-text'), status,
      make('h4', 'Preview'), previewList, make('h4', 'Safe to archive/delete'), safe, make('h4', 'Needs attention'), attention);
    let selected = [], results = [], ready = false, busy = false;
    const commit = button('Import all eligible reports', () => run(false)); commit.className = 'btn btn-primary'; commit.disabled = true;
    const retry = button('Preview / retry selection', () => run(true)); retry.disabled = true;
    const download = button('Download receipt', () => {
      const receipt = {workspaceId:workspace.value, generatedAt:new Date().toISOString(), safeToArchiveOrDelete:results.filter(r=>r.safe), needsAttention:results.filter(r=>!r.safe)};
      const url = URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)], {type:'application/json'}));
      const a = make('a'); a.href = url; a.download = 'elistly-inventory-import-receipt.json'; a.click(); URL.revokeObjectURL(url);
    }); download.disabled = true;
    actions.prepend(retry, commit, download);
    function lock(value) {
      busy = value;
      workspace.disabled = value || !ready; folder.disabled = value || !ready; files.disabled = value || !ready;
      commit.disabled = value || !selected.some(f=>f.eligible); retry.disabled = value || !selected.length;
      download.disabled = value || !results.length;
    }
    function render() {
      previewList.replaceChildren(); safe.replaceChildren(); attention.replaceChildren();
      for (const row of results) {
        const item = make('li');
        item.append(make('strong', row.filename), document.createTextNode(' — ' + (row.reason || row.disposition)));
        if (row.hostname) item.append(make('p', `${row.hostname} · ${row.context} · ${row.collectedAt}`, 'help-text'));
        if (row.identity) item.append(make('code', row.identity));
        (row.preview ? previewList : row.safe ? safe : attention).append(item);
      }
      if (!safe.childNodes.length) safe.append(make('li', 'No files confirmed safe in this result.'));
      if (!attention.childNodes.length) attention.append(make('li', 'None.'));
    }
    async function choose(list) {
      if (busy || !ready) return;
      selected = Array.from(list, file => ({file, filename:file.webkitRelativePath || file.name, eligible:false}));
      results = []; render();
      const tooLarge = selected.length > 100 || selected.reduce((sum,f)=>sum+f.file.size,0) > 4*1024*1024;
      for (const item of selected) {
        if (tooLarge) item.reason = 'Selection exceeds 100 files or 4 MiB; choose a smaller folder';
        else if (/\.pending$/i.test(item.filename)) item.reason = 'Incomplete .pending file ignored; keep until collection is complete';
        else if (!/\.json$/i.test(item.filename)) item.reason = 'Skipped: only completed JSON reports are eligible';
        else if (item.file.size > 65536) item.reason = 'Report exceeds 64 KiB';
        else if (item.filename.length > 512 || item.filename.split('/').length > 8) item.reason = 'Filename or folder depth exceeds the limit';
      }
      await run(true);
    }
    async function run(preview) {
      if (busy || !ready) return;
      lock(true);
      const workspaceId = workspace.value;
      results = [];
      try {
        if (storage._isDirty || storage._readOutbox(session.user.id).length) throw new Error('Sync or resolve pending edits before importing.');
        for (let i=0; i<selected.length; i++) {
          const item = selected[i];
          if (!active()) return;
          status.textContent = `${preview ? 'Checking' : 'Importing'} ${i+1} of ${selected.length}…`;
          if (item.reason || (!preview && !item.eligible)) {
            results.push({filename:item.filename,safe:false,reason:item.reason || item.previewReason || 'Not eligible; preview again to retry'}); continue;
          }
          try {
            const content = await item.file.text();
            if (!active()) return;
            const response = await api('/inventory-import', {method:'POST',body:{workspaceId,preview,files:[{filename:item.filename,content}]}});
            if (!active()) return;
            if (!response.ok) throw new Error(response.data?.error || 'Import request failed');
            const row = response.data?.results?.[0];
            if (!row || row.filename !== item.filename || typeof row.safe !== 'boolean') throw new Error('Unexpected import response; retry to confirm');
            item.eligible = row.disposition !== 'Needs attention'; item.previewReason = row.reason;
            results.push({...row, preview:preview && item.eligible});
          } catch (error) {
            if (!active()) return;
            item.eligible = false;
            item.previewReason = error.message;
            results.push({filename:item.filename,safe:false,reason:`${error.message}. Save may be unconfirmed; keep this file and retry.`});
          }
          render();
        }
        if (!active()) return;
        render();
        status.textContent = preview ? 'Preview only. No files are safe to archive until import confirms their saved contents.' : `${results.filter(r=>r.safe).length} files confirmed durably saved. Keep every file in Needs attention. You may retry the same selection safely.`;
        if (!preview) {
          // Read the authoritative account revision after import. Never overwrite
          // edits made while the request was running or a replacement account.
          const refreshRevision = storage._readUserUpdatedAt(session.user.id);
          const response = await api('/app-data');
          if (!active()) return;
          if (!response.ok || !response.data?.payload || !response.data.updated_at) throw new Error('Saved inventory could not be refreshed; reload before editing.');
          await storage._withStorageLock(() => {
            if (!active()) return;
            if (storage._isDirty || storage._readOutbox(session.user.id).length || storage._readUserUpdatedAt(session.user.id) !== refreshRevision) throw new Error('Inventory changed during refresh. Import receipts are preserved; reload before editing.');
            // The visible inventory and its save revision must advance together.
            if (app.applyRemoteSyncData(response.data.payload) === false) throw new Error('Close the device editor and reload before editing imported inventory.');
            storage._cached = structuredClone(response.data.payload);
            storage._cachedUserId = session.user.id;
            storage._cachedUpdatedAt = response.data.updated_at;
            storage._accountVerified = true;
            storage._writeUserCache(session.user.id, response.data.payload, response.data.updated_at);
          });
        }
      } catch (error) {
        if (active()) {
          for (const item of selected) if (!results.some(r=>r.filename===item.filename)) results.push({filename:item.filename,safe:false,reason:'Not processed: '+error.message});
          render(); status.textContent = error.message;
        }
      } finally { if (active()) lock(false); }
    }
    folder.onchange = () => choose(folder.files); files.onchange = () => choose(files.files);
    workspace.onchange = () => { selected.forEach(f=>f.eligible=false); results=[]; render(); commit.disabled=true; status.textContent='Workspace changed. Preview the selection again.'; };
    lock(true);
    try {
      const response = await api('/app-data');
      if (!active()) return;
      if (!response.ok) throw new Error(response.data?.error || 'Could not load workspaces');
      for (const [id,w] of Object.entries(response.data?.payload?.workspaces || {})) {
        if (!w.entityTypes?.computer) continue;
        const option = make('option', w.name || id); option.value=id; option.selected=id===app.data.currentWorkspaceId; workspace.append(option);
      }
      ready = workspace.options.length > 0;
      status.textContent = ready ? 'Choose a folder or files to preview.' : 'Add a Computer entity type to a workspace, sync it, then reopen this tool.';
    } catch (error) { if (active()) status.textContent=error.message; }
    finally { if (active()) lock(false); }
  }
  async function history(app, request, storage, session, deviceId) {
    if (!session?.access_token) return app.showNotification('Sign in to view saved observations.', 'error');
    const workspaceId=app.data.currentWorkspaceId, generation=storage._accountGeneration;
    const {modal,body,actions}=dialog(app,'svkHistoryModal','Saved offline observations');
    body.append(make('p','Source observations are unverified device facts, not proof of ownership, completed provisioning, or compliance. Each report keeps its collection time; later null values do not erase earlier reports.'));
    const list=make('div'),status=make('p','Loading…');body.append(status,list);
    let offset=0;
    const more=button('Load older reports',load); actions.prepend(more);
    async function load() {
      more.disabled=true;
      try {
        const response=await request(`/inventory-import/observations?workspaceId=${encodeURIComponent(workspaceId)}&deviceId=${encodeURIComponent(deviceId)}&offset=${offset}`,{authSession:session});
        if(!modal.isConnected || generation!==storage._accountGeneration) return;
        if(!response.ok) throw new Error(response.data?.error || 'Could not read observations');
        const rows=response.data.observations;
        for(const row of rows) {
          const details=make('details'),summary=make('summary',`Inventoried ${row.report.collectedAt} · imported ${row.imported_at}`);
          details.append(summary,make('pre',JSON.stringify(row.report,null,2)));list.append(details);
        }
        if(offset===0) status.textContent=rows.length ? `Last inventoried: ${rows[0].report.collectedAt}` : 'No saved offline observations for this device.';
        offset+=rows.length;more.disabled=rows.length<20;
      } catch(error) {status.textContent=error.message;more.disabled=false;}
    }
    await load();
  }
  window.ElistlySvkInventory={open,history};
})();
