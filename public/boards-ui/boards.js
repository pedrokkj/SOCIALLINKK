(function () {
  'use strict';

  const columnColors = ['#d8ff36', '#bba4ff', '#4946f5', '#f0836e', '#f2c66d', '#8bc9a1', '#ef9bbb', '#82cbd0', '#c9ccd2', '#388f79'];
  const workflowCategories = [
    ['intake', 'Produzir / solicitação'], ['production', 'Em produção'], ['internal_review', 'Revisão interna'],
    ['client_approval', 'Aguardando aprovação'], ['changes', 'Alterações'], ['schedule', 'Programar'], ['completed', 'Concluído']
  ];
  let host = null;
  let root = null;
  let boards = [];
  let activeBoardId = null;
  let showingArchivedBoards = false;
  let showingArchivedCards = false;
  let filterClientId = '';
  let filterMemberId = '';
  let filterLabelId = '';
  let filterDue = '';
  let filterCardText = '';
  let listView = false;
  let isLoading = false;
  let hasLoaded = false;
  let loadError = '';
  let draggedCardId = null;
  let draggedColumnId = null;
  let cardDetailTab = 'comments';
  let scheduleEditingCardId = '';
  let cardScheduleModes = {};
  let newCardDraftColumnId = '';
  let columnSortModes = readColumnSortModes();

  const filtersActive = () => Boolean(filterClientId || filterMemberId || filterLabelId || filterDue || filterCardText.trim());

  function cardMatches(card) {
    if (filterClientId && String(card.clientId || '') !== String(filterClientId)) return false;
    if (filterMemberId && !(card.assignees || []).some(person => String(person.id) === String(filterMemberId))) return false;
    if (filterLabelId && !(card.labels || []).some(label => String(label.id) === String(filterLabelId))) return false;
    if (filterDue === 'overdue' && !isOverdue(card.dueDate)) return false;
    if (filterDue === 'week') {
      const due = card.dueDate ? new Date(`${String(card.dueDate).slice(0, 10)}T23:59:59`) : null;
      if (!due || due < new Date() || due > new Date(Date.now() + 7 * 86400000)) return false;
    }
    if (filterDue === 'none' && card.dueDate) return false;
    const query = filterCardText.trim().toLocaleLowerCase('pt-BR');
    if (query) {
      const haystack = `${card.title || ''} ${card.description || ''} ${card.clientName || ''} ${(card.labels||[]).map(item=>item.name).join(' ')} ${(card.assignees||[]).map(item=>item.name).join(' ')}`.toLocaleLowerCase('pt-BR');
      if (!haystack.includes(query)) return false;
    }
    return true;
  }

  const esc = value => typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);

  const safeColor = value => /^#[\da-f]{6}$/i.test(String(value || '')) ? value : columnColors[0];
  const activeBoards = () => boards.filter(board => !board.archived);
  const archivedBoards = () => boards.filter(board => board.archived);
  const activeBoard = () => activeBoards().find(board => String(board.id) === String(activeBoardId)) || null;
  const sorted = items => [...(Array.isArray(items) ? items : [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  function readColumnSortModes(){try{return JSON.parse(localStorage.getItem('social-ink:column-sort:v1')||'{}')||{};}catch{return {};}}
  function getColumnSortMode(boardId,columnId){return columnSortModes[`${boardId}:${columnId}`]||'manual';}
  function setColumnSortMode(boardId,columnId,mode){columnSortModes[`${boardId}:${columnId}`]=mode;try{localStorage.setItem('social-ink:column-sort:v1',JSON.stringify(columnSortModes));}catch{}}
  function sortedColumnCards(boardId,columnId,cards){
    const mode=getColumnSortMode(boardId,columnId),items=sorted(cards);
    if(mode==='created-desc')return items.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    if(mode==='created-asc')return items.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
    if(mode==='name-asc')return items.sort((a,b)=>String(a.title||'').localeCompare(String(b.title||''),'pt-BR',{sensitivity:'base'}));
    return items;
  }
  const currentClients = () => typeof state !== 'undefined' && Array.isArray(state.clients) ? state.clients : [];
  const userPermissions = () => typeof state !== 'undefined' && Array.isArray(state.user?.role?.permissions) ? state.user.role.permissions : [];
  const canWrite = () => userPermissions().includes('boards.write');
  const canReadClients = () => userPermissions().includes('clients.read');

  const dateLabel = value => {
    if (!value) return '';
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(date).replace('.', '');
  };

  const isOverdue = value => {
    if (!value) return false;
    const due = new Date(`${String(value).slice(0, 10)}T23:59:59`);
    return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
  };

  const callToast = (message, error = false) => {
    if (typeof toast === 'function') toast(message, error);
  };

  const apiCall = (path, options) => {
    if (typeof api !== 'function') throw new Error('A conexão com o workspace não está disponível.');
    return api(path, options);
  };

  const requestBody = data => ({ method: 'POST', body: JSON.stringify(data) });
  const putBody = data => ({ method: 'PUT', body: JSON.stringify(data) });
  const pathPart = value => encodeURIComponent(String(value));
  const icon = (name, size = 16) => {
    const paths = {
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>', users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>', tag: '<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L3.4 13.4V3h10.4l6.8 6.8a2 2 0 0 1-.01 3.61Z"/><circle cx="7.5" cy="7.5" r="1"/>', filter: '<path d="M4 7h16M7 12h10m-7 5h4"/>', calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16"/>', list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>', plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m18 6-12 12M6 6l12 12"/>', edit: '<path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/>', trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m4 4v7m6-7v7"/>', archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9m-8 4h2"/>', chevronLeft: '<path d="m15 18-6-6 6-6"/>', chevronRight: '<path d="m9 18 6-6-6-6"/>', arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>', arrowDown: '<path d="m19 12-7 7-7-7M12 5v14"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20l1.1-4.1A8.5 8.5 0 1 1 21 11.5Z"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', arrowRight: '<path d="M5 12h14m-7-7 7 7-7 7"/>', checkSquare: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>', paperclip: '<path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48"/>', image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>', file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h8"/>', link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
    };
    return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.board}</svg>`;
  };

  function selectMenu(id, label, options, action, extra = {}) {
    return `<div class="si-select${extra.className ? ` ${extra.className}` : ''}" data-select-id="${esc(id)}">
      <button class="si-select-trigger" type="button" data-action="toggle-menu" aria-haspopup="listbox" aria-expanded="false">${extra.icon ? icon(extra.icon,15) : ''}<span>${esc(label)}</span>${icon('chevronRight',13)}</button>
      <div class="si-select-menu" role="listbox" hidden>
        ${options.map(option => `<button type="button" role="option" aria-selected="${String(option.value)===String(extra.value??'')}" data-action="${esc(action)}" data-value="${esc(option.value)}" ${Object.entries(extra.attrs||{}).map(([key,value])=>`data-${key}="${esc(value)}"`).join(' ')}>${option.color?`<i class="si-option-dot" style="--option-color:${safeColor(option.color)}"></i>`:''}<span>${esc(option.label)}</span>${String(option.value)===String(extra.value??'')?'<b>✓</b>':''}</button>`).join('')}
      </div>
    </div>`;
  }

  function countActiveCards(board) {
    if (!board || !Array.isArray(board.columns)) return 0;
    return board.columns.reduce((sum, col) => sum + (Array.isArray(col.cards) ? col.cards.filter(c => !c.archived).length : 0), 0);
  }

  function totalCardsCount() {
    return activeBoards().reduce((sum, b) => sum + countActiveCards(b), 0);
  }

  function totalColumnsCount() {
    return activeBoards().reduce((sum, b) => sum + (b.columns?.filter(c => !c.archived).length || 0), 0);
  }

  function ensureStylesheet() {
    if (document.getElementById('social-ink-boards-css')) return;
    const link = document.createElement('link');
    link.id = 'social-ink-boards-css';
    link.rel = 'stylesheet';
    link.href = '/boards-ui/boards.css?v=9';
    document.head.appendChild(link);
  }

  function resolveHost(target) {
    if (target && target.nodeType === 1) return target;
    if (typeof target === 'string') {
      const found = document.querySelector(target);
      if (found) return found;
    }
    const known = document.getElementById('page-boards') || document.querySelector('.boards-ui-host');
    if (known) return known;
    const fallback = document.createElement('section');
    fallback.className = 'page boards-ui-host';
    fallback.id = 'page-boards';
    const parent = document.querySelector('.main-area') || document.querySelector('#app') || document.body;
    parent.appendChild(fallback);
    return fallback;
  }

  function mount(target) {
    ensureStylesheet();
    host = resolveHost(target);
    root = host.matches('.boards-ui') ? host : host.querySelector('.boards-ui');
    if (!root) {
      root = document.createElement('div');
      root.className = 'boards-ui';
      host.appendChild(root);
    }
    if (root.dataset.boardsBound !== 'true') {
      bindEvents();
      root.dataset.boardsBound = 'true';
    }
  }

  async function loadBoards(showSkeleton = false) {
    if (showSkeleton && !hasLoaded) isLoading = true;
    loadError = '';
    render();
    let succeeded = false;
    try {
      const response = await apiCall('/api/boards');
      boards = Array.isArray(response?.boards) ? response.boards : [];
      boards = boards.map(board => ({
        ...board,
        columns: Array.isArray(board.columns) ? board.columns.map(column => ({
          ...column,
          cards: Array.isArray(column.cards) ? column.cards : []
        })) : []
      }));
      // If activeBoardId was set, verify it still exists in active boards
      if (activeBoardId) {
        const exists = activeBoards().some(board => String(board.id) === String(activeBoardId));
        if (!exists) activeBoardId = null;
      }
      hasLoaded = true;
      succeeded = true;
    } catch (error) {
      loadError = error?.message || 'Não foi possível carregar os quadros.';
    } finally {
      isLoading = false;
      render();
    }
    return succeeded;
  }

  function render() {
    if (!root) return;
    const active = document.activeElement;
    const searchFocused = Boolean(active && active.matches && active.matches('[data-action="search-cards"]'));
    const caret = searchFocused ? active.selectionStart : null;
    root.innerHTML = `<div class="boards-shell">
      ${renderHeader()}
      ${renderMain()}
    </div>`;
    if (searchFocused) {
      const input = root.querySelector('[data-action="search-cards"]');
      if (input) {
        input.focus();
        if (caret !== null) input.setSelectionRange(caret, caret);
      }
    }
  }

  function renderHeader() {
    if (activeBoard() && !showingArchivedBoards) return '';
    return `<div class="boards-top">
      <div class="boards-top-copy">
        <p class="eyebrow">ORGANIZAÇÃO · KANBAN</p>
        <h1>Quadros</h1>
      </div>
      <div class="boards-top-actions">
        ${canWrite() ? `<button class="primary-btn" type="button" data-action="new-board">＋ Novo quadro</button>` : ''}
      </div>
    </div>`;
  }

  function renderMain() {
    if (isLoading) {
      return `<div class="dashboard-loading"><span class="status-dot"></span> Carregando quadros…</div>`;
    }
    if (loadError) {
      return `<section class="panel flow-empty" role="alert">
        <div class="empty-illustration">!</div>
        <h3>Não foi possível carregar os quadros</h3>
        <p>${esc(loadError)}</p>
        <button class="secondary-btn" type="button" data-action="retry">Tentar novamente</button>
      </section>`;
    }

    const board = activeBoard();
    if (board && !showingArchivedBoards) {
      return renderBoardWorkspace(board);
    }

    return renderBoardMenu();
  }

  function renderBoardMenu() {
    const actList = activeBoards();
    const archList = archivedBoards();
    const items = showingArchivedBoards ? archList : actList;

    const tabsMarkup = `<div class="approval-tabs" role="tablist" aria-label="Seletor de quadros">
      <button type="button" role="tab" aria-selected="${!showingArchivedBoards}" class="approval-tab ${!showingArchivedBoards ? 'active' : ''}" data-action="tab-active-boards">Quadros ativos <span>${actList.length}</span></button>
      <button type="button" role="tab" aria-selected="${showingArchivedBoards}" class="approval-tab ${showingArchivedBoards ? 'active' : ''}" data-action="tab-archived-boards">Arquivados <span>${archList.length}</span></button>
    </div>`;

    if (!items.length) {
      return `${tabsMarkup}
        <section class="panel flow-empty">
          <div class="empty-illustration">▤</div>
          <h3>${showingArchivedBoards ? 'Nenhum quadro arquivado' : 'Seu primeiro quadro começa aqui.'}</h3>
          <p>${showingArchivedBoards ? 'Quando um quadro sair de uso, você poderá guardá-lo aqui e restaurá-lo quando precisar.' : 'Organize pautas, produção visual, revisões e tarefas da agência em quadros Kanban flexíveis.'}</p>
          ${!showingArchivedBoards && canWrite() ? `<button class="primary-btn" type="button" data-action="new-board">Criar primeiro quadro</button>` : ''}
        </section>`;
    }

    const cardsMarkup = `<div class="boards-menu-grid">
      ${items.map(b => {
        const cols = b.columns?.filter(c => !c.archived) || [];
        const cardCount = countActiveCards(b);
        return `<button type="button" class="board-choice-card" data-action="${showingArchivedBoards ? 'noop' : 'select-board'}" data-board-id="${esc(b.id)}">
          <span class="board-choice-icon">▤</span>
          <div class="board-choice-copy">
            <b>${esc(b.name)}</b>
            <small>${esc(b.description || 'Sem descrição cadastrada.')} · ${cols.length} ${cols.length === 1 ? 'coluna' : 'colunas'} · ${cardCount} ${cardCount === 1 ? 'cartão' : 'cartões'}</small>
          </div>
          <div class="board-column-tags">
            ${cols.map(c => `<span class="board-column-tag" style="border-left: 3px solid ${safeColor(c.color)}">${esc(c.name)}</span>`).slice(0, 3).join('')}
            ${cols.length > 3 ? `<span class="board-column-tag more">+${cols.length - 3}</span>` : ''}
          </div>
          ${showingArchivedBoards ? (canWrite() ? `<button class="secondary-btn" type="button" data-action="restore-board" data-board-id="${esc(b.id)}" style="margin-left:auto;">Restaurar</button>` : '') : '<span class="row-chevron">›</span>'}
        </button>`;
      }).join('')}
    </div>`;

    return `${tabsMarkup}${cardsMarkup}`;
  }

  function renderBoardWorkspace(board) {
    const columns = sorted(board.columns.filter(column => !column.archived));
    const archivedColumns = sorted(board.columns.filter(column => column.archived));
    const archivedCards = board.columns.flatMap(column => column.cards
      .filter(card => card.archived)
      .map(card => ({ ...card, columnName: column.name, columnArchived: column.archived })));
    const allCards = countActiveCards(board);

    return `<section class="boards-board">
      <div class="board-workspace-head-bar">
        <button type="button" class="board-back-button" data-action="back-to-menu" aria-label="Voltar para todos os quadros" title="Todos os quadros">${icon('chevronLeft',17)}</button>
        <h1>${esc(board.name)}</h1>
        <div class="board-head-meta"><span>${columns.length} ${columns.length === 1 ? 'coluna' : 'colunas'}</span><i></i><span>${allCards} ${allCards === 1 ? 'cartão' : 'cartões'}</span></div>
        <div class="board-head-actions">
          ${canWrite() ? `<button class="boards-icon-btn" type="button" data-action="new-column" title="Adicionar coluna" aria-label="Adicionar coluna">${icon('plus',16)}</button>` : ''}
          <button class="board-settings-trigger" type="button" data-action="board-options" aria-label="Opções do quadro" title="Opções do quadro">${icon('menu',18)}</button>
        </div>
      </div>

      <div class="boards-toolbar" aria-label="Filtros do quadro">
        ${selectMenu('filter-client',currentClients().find(c=>String(c.id)===String(filterClientId))?.name||'Todos os clientes',[{value:'',label:'Todos os clientes'},...currentClients().map(client=>({value:client.id,label:client.name}))],'choose-filter',{icon:'users',attrs:{filter:'client'},value:filterClientId})}
        ${selectMenu('filter-member',(board.members||[]).find(m=>String(m.id)===String(filterMemberId))?.name||'Toda a equipe',[{value:'',label:'Toda a equipe'},...(board.members||[]).map(member=>({value:member.id,label:member.name}))],'choose-filter',{icon:'users',attrs:{filter:'member'},value:filterMemberId})}
        ${selectMenu('filter-label',(board.labels||[]).find(l=>String(l.id)===String(filterLabelId))?.name||'Todas as etiquetas',[{value:'',label:'Todas as etiquetas'},...(board.labels||[]).map(label=>({value:label.id,label:label.name,color:label.color}))],'choose-filter',{icon:'tag',attrs:{filter:'label'},value:filterLabelId})}
        ${selectMenu('filter-due',({overdue:'Atrasados',week:'Próximos 7 dias',none:'Sem prazo'})[filterDue]||'Todos os prazos',[{value:'',label:'Todos os prazos'},{value:'overdue',label:'Atrasados'},{value:'week',label:'Próximos 7 dias'},{value:'none',label:'Sem prazo'}],'choose-filter',{icon:'calendar',attrs:{filter:'due'},value:filterDue})}
        <label class="boards-filter-search">${icon('search',16)}<input type="search" data-action="search-cards" value="${esc(filterCardText)}" placeholder="Buscar cartões..." aria-label="Buscar cartões"></label>
        ${filtersActive() ? `<button class="boards-clear-filters" type="button" data-action="clear-filters">${icon('close',14)} Limpar filtros</button>` : ''}
        <div class="boards-view-toggle" role="group" aria-label="Modo de visualização"><button type="button" class="${!listView?'active':''}" data-action="toggle-view" data-view="board" aria-label="Visualização em quadro" title="Quadro">${icon('board',16)}</button><button type="button" class="${listView?'active':''}" data-action="toggle-view" data-view="list" aria-label="Visualização em lista" title="Lista">${icon('list',16)}</button></div>
      </div>

      ${columns.length ? `
        <div class="boards-columns${listView?' is-list-view':''}" aria-label="Colunas do quadro">
          ${columns.map((column, index) => renderColumn(board, column, index, columns)).join('')}
          ${canWrite() ? `
            <button class="boards-add-column-card" type="button" data-action="new-column" aria-label="Adicionar coluna">
              <span class="boards-plus" aria-hidden="true">＋</span> Nova coluna
            </button>
          ` : ''}
        </div>
      ` : `
        <section class="panel flow-empty">
          <div class="empty-illustration">＋</div>
          <h3>${canWrite() ? 'Desenhe seu fluxo' : 'Este quadro ainda não tem colunas'}</h3>
          <p>${canWrite() ? 'Crie as colunas que fazem sentido para este trabalho (ex.: A fazer, Em produção, Aguardando aprovação, Concluído).' : 'As colunas aparecerão aqui quando forem criadas pela equipe.'}</p>
          ${canWrite() ? `<button class="primary-btn" type="button" data-action="new-column">Criar primeira coluna</button>` : ''}
        </section>
      `}

      ${renderArchivedColumns(archivedColumns)}
      ${renderArchivedCards(archivedCards)}
    </section>`;
  }

  function renderMemberAvatars(members, limit = 5) {
    const shown = members.slice(0, limit);
    return `${shown.map(member => `<button type="button" class="board-avatar" data-action="show-member" data-member-id="${esc(member.id)}" title="${esc(member.name)} · ${esc(member.role||'Equipe')}" style="--profile-color:${safeColor(member.color||'#d8ff36')}">${profileAvatarMarkup(member)}</button>`).join('')}${members.length>limit?`<span class="board-avatar-overflow">+${members.length-limit}</span>`:''}`;
  }

  function profileAvatarMarkup(member){const glyphs={orbit:'✳',spark:'✦',wave:'≈',leaf:'❋',pixel:'▦',sun:'☼',moon:'☾',bolt:'ϟ',flower:'✿',gem:'◆',fox:'♢',cat:'◉'};return member.avatar?`<span class="board-profile-glyph">${glyphs[member.avatar]||'✳'}</span>`:esc((member.name||'?').split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase());}

  function renderColumnActions(board,column,cards,columns){
    const mode=getColumnSortMode(board.id,column.id),targets=columns.filter(item=>String(item.id)!==String(column.id));
    const currentCategory=String(column.workflowCategory||'');
    const usedCategories=new Map(columns.filter(item=>!item.archived&&String(item.id)!==String(column.id)&&item.workflowCategory).map(item=>[item.workflowCategory,item.name]));
    const sortOptions=[['created-desc','Data de criação (mais recente primeiro)'],['created-asc','Data de criação (mais antigo primeiro)'],['name-asc','Nome do cartão (ordem alfabética)']];
    return `<div class="boards-column-actions"><div class="si-select column-actions-select" data-select-id="column-actions-${esc(column.id)}">
      <button class="boards-icon-btn" type="button" data-action="toggle-menu" aria-haspopup="menu" aria-expanded="false" title="Ações da lista" aria-label="Ações da lista">${icon('more',15)}</button>
      <div class="si-select-menu column-actions-menu" role="menu" hidden>
        <p class="column-menu-heading">Ações da lista</p>
        <button type="button" role="menuitem" class="column-menu-row" data-action="toggle-column-submenu" data-submenu="category" data-column-id="${esc(column.id)}" aria-haspopup="menu" aria-expanded="false"><i>⌘</i><span>Categoria da coluna${currentCategory?` · ${esc(workflowCategories.find(([key])=>key===currentCategory)?.[1]||'')}`:''}</span>${icon('chevronRight',13)}</button>
        <div class="column-submenu column-category-submenu" data-column-submenu="category" role="menu" hidden><p class="column-menu-heading">Categoria interna</p><p class="column-category-note">Cada categoria pode ser usada uma vez neste quadro.</p><button type="button" role="menuitemradio" aria-checked="${!currentCategory}" data-action="set-column-category" data-column-id="${esc(column.id)}" data-category=""><i>${!currentCategory?'✓':''}</i><span>Sem categoria</span></button>${workflowCategories.map(([key,label])=>{const takenBy=usedCategories.get(key),selected=currentCategory===key,disabled=Boolean(takenBy)&&!selected;return `<button type="button" role="menuitemradio" aria-checked="${selected}" data-action="set-column-category" data-column-id="${esc(column.id)}" data-category="${key}" ${disabled?`disabled title="Já usada na coluna ${esc(takenBy)}"`:''}><i>${selected?'✓':''}</i><span>${esc(label)}${disabled?` <small>Usada em ${esc(takenBy)}</small>`:''}</span></button>`;}).join('')}</div>
        <button type="button" role="menuitem" data-action="new-card" data-column-id="${esc(column.id)}"><i>＋</i><span>Adicionar cartão</span></button>
        <button type="button" role="menuitem" class="column-menu-row" data-action="toggle-column-submenu" data-submenu="move" data-column-id="${esc(column.id)}" aria-haspopup="menu" aria-expanded="false" ${cards.length?'':'disabled'}><i>⇄</i><span>Mover todos os cartões nesta lista</span>${icon('chevronRight',13)}</button>
        <div class="column-submenu" data-column-submenu="move" role="menu" hidden><p class="column-menu-heading">Mover para lista</p>${targets.length?targets.map(target=>`<button type="button" role="menuitem" data-action="move-all-cards" data-column-id="${esc(column.id)}" data-target-column-id="${esc(target.id)}"><i class="boards-column-dot" style="--column-color:${safeColor(target.color)}"></i><span>${esc(target.name)}</span></button>`).join(''):'<p class="column-menu-empty">Não há outras listas neste quadro.</p>'}</div>
        <button type="button" role="menuitem" class="column-menu-row" data-action="toggle-column-submenu" data-submenu="sort" data-column-id="${esc(column.id)}" aria-haspopup="menu" aria-expanded="false"><i>↕</i><span>Ordenar por</span>${icon('chevronRight',13)}</button>
        <div class="column-submenu" data-column-submenu="sort" role="menu" hidden><p class="column-menu-heading">Ordenar lista</p>${sortOptions.map(([value,label])=>`<button type="button" role="menuitemradio" aria-checked="${mode===value}" data-action="sort-column-cards" data-column-id="${esc(column.id)}" data-sort-mode="${value}"><i>${mode===value?'✓':''}</i><span>${label}</span></button>`).join('')}</div>
        <div class="column-menu-color-block"><span>Alterar cor da lista</span><div class="column-color-grid">${columnColors.map(color=>`<button type="button" class="column-color-swatch${safeColor(column.color).toLowerCase()===color.toLowerCase()?' is-selected':''}" style="--swatch:${color}" data-action="set-column-color" data-column-id="${esc(column.id)}" data-color="${color}" title="${color}" aria-label="Usar cor ${color}" aria-pressed="${safeColor(column.color).toLowerCase()===color.toLowerCase()}"></button>`).join('')}</div></div>
        <button type="button" role="menuitem" class="column-menu-danger" data-action="archive-column-cards" data-column-id="${esc(column.id)}" ${cards.length?'':'disabled'}><i>⌑</i><span>Arquivar todos os cartões nesta lista</span></button>
        <div class="column-menu-divider"></div><button type="button" role="menuitem" data-action="edit-column" data-column-id="${esc(column.id)}"><i>✎</i><span>Editar nome ou excluir lista</span></button>
      </div>
    </div></div>`;
  }

  function renderColumn(board, column, index, columns) {
    const cards = sortedColumnCards(board.id,column.id,column.cards.filter(card => !card.archived));
    const visibleCards = cards.filter(cardMatches);
    const hasDraft = String(newCardDraftColumnId) === String(column.id);
    return `<section class="boards-column" ${canWrite() ? `data-drop-column="${esc(column.id)}" data-drag-column="${esc(column.id)}" draggable="true"` : ''} aria-label="${esc(column.name)}" style="--column-color:${safeColor(column.color)}">
      <div class="boards-column-head">
        <span class="boards-column-dot" aria-hidden="true"></span>
        <span class="boards-column-name">${esc(column.name)}</span>
        <span class="boards-column-count" title="${visibleCards.length} exibidos de ${cards.length}">${filtersActive()?`${visibleCards.length}/${cards.length}`:cards.length}</span>
        ${canWrite() ? renderColumnActions(board,column,cards,columns) : ''}
      </div>
      <div class="boards-column-cards">
        ${visibleCards.map(card => renderCard(board, column, card, cards.findIndex(item=>item.id===card.id), cards, columns)).join('')}
        ${cards.length && !visibleCards.length ? `<div class="boards-filter-empty">Nenhum cartão corresponde aos filtros.</div>` : ''}
        ${hasDraft ? `<article class="boards-card boards-card-draft"><input class="boards-inline-card-title" data-action="inline-card-title" data-column-id="${esc(column.id)}" maxlength="180" placeholder="Insira um título para o cartão" aria-label="Título do novo cartão" autofocus></article>` : ''}
      </div>
      ${canWrite() ? `<div class="boards-column-footer">${hasDraft?`<div class="boards-inline-card-actions"><button class="boards-add-card is-confirm" type="button" data-action="submit-inline-card" data-column-id="${esc(column.id)}"><span aria-hidden="true">✓</span> Criar cartão</button><button class="boards-inline-card-cancel" type="button" data-action="cancel-inline-card" data-column-id="${esc(column.id)}" aria-label="Cancelar criação do cartão" title="Cancelar">${icon('close',15)}</button></div>`:`<button class="boards-add-card" type="button" data-action="new-card" data-column-id="${esc(column.id)}"><span aria-hidden="true">＋</span> Adicionar cartão</button>`}</div>` : ''}
    </section>`;
  }

  function renderCard(board, column, card, index, cards, columns) {
    const matchedClient = card.clientName || '';
    const due = dateLabel(card.dueDate);
    const description = String(card.description || '').trim();
    const cover=(card.attachments||[]).find(item=>String(item.mimeType||'').startsWith('image/'));
    return `<article class="boards-card" draggable="${canWrite() ? 'true' : 'false'}" data-card-id="${esc(card.id)}" data-card-column="${esc(column.id)}" data-card-index="${index}" data-action="open-card" title="Abrir detalhes do cartão">
      <div class="boards-card-heading"><h3 class="boards-card-title">${esc(card.title)}</h3>${cover?`<img class="boards-card-cover" src="${esc(cover.href)}" alt="Capa do cartão: ${esc(cover.originalName)}">`:''}</div>
      ${description ? `<p class="boards-card-description">${esc(description)}</p>` : ''}
      ${(matchedClient || due || card.labels?.length) ? `<div class="boards-card-tags">
        ${matchedClient ? `<span class="boards-tag boards-tag-client" title="Cliente associado">${icon('board',12)} ${esc(matchedClient)}</span>` : ''}
        ${(card.labels||[]).map(label=>`<span class="boards-label-chip" style="--label-color:${safeColor(label.color)}">${esc(label.name)}</span>`).join('')}
        ${due ? `<span class="boards-tag boards-tag-due${isOverdue(card.dueDate) ? ' is-overdue' : ''}" title="Prazo">${icon('calendar',12)} ${isOverdue(card.dueDate) ? 'Atrasado · ' : ''}${esc(due)}</span>` : ''}
      </div>` : ''}
      ${card.assignees?.length ? `<div class="boards-card-assignees">${renderMemberAvatars(card.assignees,4)}<small>${card.assignees.length===1?'Responsável':'Responsáveis'}</small></div>` : ''}
      ${canWrite() ? `<div class="boards-card-actions">
        <div class="boards-card-actions-left">
          <button class="boards-icon-btn" type="button" data-action="shift-card" data-card-id="${esc(card.id)}" data-column-id="${esc(column.id)}" data-direction="up" ${index === 0 ? 'disabled' : ''} title="Mover para cima">${icon('arrowUp',13)}</button>
          <button class="boards-icon-btn" type="button" data-action="shift-card" data-card-id="${esc(card.id)}" data-column-id="${esc(column.id)}" data-direction="down" ${index === cards.length - 1 ? 'disabled' : ''} title="Mover para baixo">${icon('arrowDown',13)}</button>
        </div>
        <div class="boards-card-actions-right">
          <button class="boards-icon-btn is-danger" type="button" data-action="archive-card" data-card-id="${esc(card.id)}" data-column-id="${esc(column.id)}" title="Arquivar cartão">${icon('archive',13)}</button>
        </div>
      </div>` : ''}
    </article>`;
  }

  function renderArchivedColumns(columns) {
    if (!columns.length) return '';
    return `<section class="boards-panel boards-archived-section">
      <div class="boards-archived-head">
        <h3>Colunas arquivadas</h3>
        <span class="boards-tab-count">${columns.length}</span>
      </div>
      <div class="boards-archived-list">
        ${columns.map(col => `
          <div class="boards-archived-item">
            <div>
              <b>${esc(col.name)}</b>
              <small>${col.cards?.length || 0} cartões preservados</small>
            </div>
            ${canWrite() ? `<button class="secondary-btn" type="button" data-action="restore-column" data-column-id="${esc(col.id)}">Restaurar coluna</button>` : ''}
          </div>
        `).join('')}
      </div>
    </section>`;
  }

  function renderArchivedCards(items) {
    if (!items.length) return '';
    const expanded = showingArchivedCards;
    return `<section class="boards-panel boards-archived-section">
      <div class="boards-archived-head" data-action="toggle-card-archive">
        <h3>Cartões arquivados (${items.length})</h3>
        <button class="secondary-btn" type="button" data-action="toggle-card-archive">${expanded ? 'Ocultar' : 'Exibir'}</button>
      </div>
      ${expanded ? `
        <div class="boards-archived-list">
          ${items.map(card => `
            <div class="boards-archived-item">
              <div>
                <b>${esc(card.title)}</b>
                <small>${esc(card.columnName || 'Coluna')}${card.columnArchived ? ' · coluna arquivada' : ''}</small>
              </div>
              ${canWrite() ? (card.columnArchived
                ? `<small class="muted">Restaure a coluna primeiro</small>`
                : `<button class="secondary-btn" type="button" data-action="restore-card" data-card-id="${esc(card.id)}">Restaurar cartão</button>`) : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
    </section>`;
  }

  /* MODALS via official application #modal */

  function openCreateBoardModal() {
    if (!canWrite()) return;
    const modalEl = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');
    if (!modalEl || !modalContent) return;

    modalContent.innerHTML = `
      <p class="eyebrow">ORGANIZAÇÃO · KANBAN</p>
      <h2>Novo quadro</h2>
      <p class="muted">Dê um nome para identificar o quadro. Ele já virá com as colunas iniciais (A fazer, Em andamento, Concluído) prontas para organizar tarefas.</p>
      <div class="client-form">
        <div class="field full">
          <label for="new-board-name">Nome do quadro</label>
          <input id="new-board-name" name="name" maxlength="100" required autofocus placeholder="Ex.: Produção Semanal, Demandas da Marca, Campanha...">
        </div>
        <div class="field full">
          <label for="new-board-description">Descrição <small class="muted">(opcional)</small></label>
          <textarea id="new-board-description" name="description" maxlength="1000" placeholder="Qual o escopo ou objetivo deste quadro de trabalho?"></textarea>
        </div>
      </div>
      <div class="form-actions">
        <button class="secondary-btn" type="button" data-modal-close>Cancelar</button>
        <button class="primary-btn" type="button" id="submit-create-board">Criar quadro</button>
      </div>
    `;

    modalEl.showModal();
    modalEl.querySelectorAll('[data-modal-close]').forEach(b => b.onclick = () => modalEl.close());

    const submitBtn = document.getElementById('submit-create-board');
    submitBtn.onclick = async () => {
      const name = document.getElementById('new-board-name')?.value.trim();
      const description = document.getElementById('new-board-description')?.value.trim() || '';
      if (!name) {
        callToast('Informe o nome do quadro.', true);
        document.getElementById('new-board-name')?.focus();
        return;
      }
      submitBtn.disabled = true;
      try {
        const result = await apiCall('/api/boards', requestBody({ name, description }));
        modalEl.close();
        callToast('Quadro criado com sucesso.');
        if (result?.board) {
          activeBoardId = result.board.id;
        }
        await loadBoards(false);
      } catch (err) {
        callToast(err?.message || 'Não foi possível criar o quadro.', true);
        submitBtn.disabled = false;
      }
    };
  }

  function openEditBoardModal(board) {
    if (!canWrite() || !board) return;
    const modalEl = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');
    if (!modalEl || !modalContent) return;

    modalContent.innerHTML = `
      <p class="eyebrow">ORGANIZAÇÃO · KANBAN</p>
      <h2>Editar quadro</h2>
      <p class="muted">Atualize o nome ou a descrição deste quadro de trabalho.</p>
      <div class="client-form">
        <div class="field full">
          <label for="edit-board-name">Nome do quadro</label>
          <input id="edit-board-name" name="name" maxlength="100" required autofocus value="${esc(board.name)}">
        </div>
        <div class="field full">
          <label for="edit-board-description">Descrição <small class="muted">(opcional)</small></label>
          <textarea id="edit-board-description" name="description" maxlength="1000">${esc(board.description || '')}</textarea>
        </div>
      </div>
      <div class="form-actions">
        <button class="secondary-btn is-danger" type="button" data-action="archive-board" data-board-id="${esc(board.id)}">Arquivar quadro</button>
        <button class="secondary-btn" type="button" data-modal-close>Cancelar</button>
        <button class="primary-btn" type="button" id="submit-edit-board">Salvar alterações</button>
      </div>
    `;

    modalEl.showModal();
    modalEl.querySelectorAll('[data-modal-close]').forEach(b => b.onclick = () => modalEl.close());

    const submitBtn = document.getElementById('submit-edit-board');
    submitBtn.onclick = async () => {
      const name = document.getElementById('edit-board-name')?.value.trim();
      const description = document.getElementById('edit-board-description')?.value.trim() || '';
      if (!name) {
        callToast('Informe o nome do quadro.', true);
        return;
      }
      submitBtn.disabled = true;
      try {
        await apiCall(`/api/boards/${pathPart(board.id)}`, putBody({ name, description }));
        modalEl.close();
        callToast('Quadro atualizado com sucesso.');
        await loadBoards(false);
      } catch (err) {
        callToast(err?.message || 'Não foi possível atualizar o quadro.', true);
        submitBtn.disabled = false;
      }
    };
  }

  function openColumnModal(board, column = null) {
    if (!canWrite() || !board) return;
    const modalEl = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');
    if (!modalEl || !modalContent) return;

    const initialColor = safeColor(column?.color || columnColors[(board.columns?.length || 0) % columnColors.length]);

    modalContent.innerHTML = `
      <p class="eyebrow">ORGANIZAÇÃO · COLUNAS</p>
      <h2>${column ? 'Editar coluna' : 'Nova coluna'}</h2>
      <p class="muted">Personalize o fluxo de trabalho com colunas sob medida para suas etapas.</p>
      <div class="client-form">
        <div class="field full">
          <label for="col-modal-name">Nome da coluna</label>
          <input id="col-modal-name" maxlength="80" required autofocus value="${esc(column?.name || '')}" placeholder="Ex.: Em revisão, Aguardando cliente, Concluído...">
        </div>
        <div class="field full">
          <label for="col-modal-color">Cor de identificação</label>
          <div style="display:flex;align-items:center;gap:10px;">
            <input id="col-modal-color" type="color" value="${initialColor}" style="width:44px;height:38px;padding:2px;cursor:pointer;border-radius:8px;border:1px solid #dcdfd6;">
            <div class="color-swatches-grid">
              ${columnColors.map(c => `<button type="button" class="color-swatch-btn ${c.toLowerCase() === initialColor.toLowerCase() ? 'is-active' : ''}" data-pick-color="${c}" style="background:${c}"></button>`).join('')}
            </div>
          </div>
        </div>
      </div>
      <div class="form-actions">
        ${column ? `<button class="secondary-btn is-danger" type="button" data-action="archive-column" data-column-id="${esc(column.id)}">Excluir coluna</button>` : ''}
        <button class="secondary-btn" type="button" data-modal-close>Cancelar</button>
        <button class="primary-btn" type="button" id="submit-col-btn">${column ? 'Salvar alterações' : 'Criar coluna'}</button>
      </div>
    `;

    modalEl.showModal();
    modalEl.querySelectorAll('[data-modal-close]').forEach(b => b.onclick = () => modalEl.close());

    modalContent.querySelectorAll('[data-pick-color]').forEach(btn => {
      btn.onclick = () => {
        const color = btn.dataset.pickColor;
        const input = document.getElementById('col-modal-color');
        if (input) input.value = color;
        modalContent.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.toggle('is-active', b === btn));
      };
    });

    const submitBtn = document.getElementById('submit-col-btn');
    submitBtn.onclick = async () => {
      const name = document.getElementById('col-modal-name')?.value.trim();
      const color = safeColor(document.getElementById('col-modal-color')?.value);
      if (!name) {
        callToast('Informe o nome da coluna.', true);
        return;
      }
      submitBtn.disabled = true;
      try {
        if (column) {
          await apiCall(`/api/boards/${pathPart(board.id)}/columns/${pathPart(column.id)}`, putBody({ name, color }));
          callToast('Coluna atualizada.');
        } else {
          await apiCall(`/api/boards/${pathPart(board.id)}/columns`, requestBody({ name, color }));
          callToast('Coluna criada com sucesso.');
        }
        modalEl.close();
        await loadBoards(false);
      } catch (err) {
        callToast(err?.message || 'Erro ao salvar coluna.', true);
        submitBtn.disabled = false;
      }
    };
  }

  function openBoardOptionsModal(board) {
    if (!board) return;
    const modalEl = document.getElementById('modal');
    const content = document.getElementById('modal-content');
    if (!modalEl || !content) return;
    content.innerHTML = `
      <p class="eyebrow">CONFIGURAÇÕES</p>
      <h2>${esc(board.name)}</h2>
      <p class="muted">Acesse as opções do quadro em um só lugar.</p>
      <div class="board-options-list">
        <button type="button" data-action="manage-members">${icon('users',18)}<span><b>Equipe e participantes</b><small>Adicionar pessoas e consultar cargos</small></span>${icon('chevronRight',16)}</button>
        <button type="button" data-action="manage-labels">${icon('tag',18)}<span><b>Etiquetas</b><small>Organizar cartões por categoria</small></span>${icon('chevronRight',16)}</button>
        ${canWrite() ? `
          <button type="button" data-action="new-column">${icon('plus',18)}<span><b>Adicionar coluna</b><small>Criar uma etapa para este fluxo</small></span>${icon('chevronRight',16)}</button>
          <button type="button" data-action="edit-board" data-board-id="${esc(board.id)}">${icon('edit',18)}<span><b>Editar quadro</b><small>Alterar nome e descrição</small></span>${icon('chevronRight',16)}</button>
          <button class="is-danger" type="button" data-action="reset-board" data-board-id="${esc(board.id)}">${icon('archive',18)}<span><b>Reiniciar quadro</b><small>Guardar o fluxo atual e começar novamente</small></span>${icon('chevronRight',16)}</button>
          <button class="is-danger" type="button" data-action="archive-board" data-board-id="${esc(board.id)}">${icon('trash',18)}<span><b>Arquivar quadro</b><small>Retirar da lista ativa; dá para restaurar</small></span>${icon('chevronRight',16)}</button>
        ` : ''}
      </div>
      <div class="form-actions"><button class="secondary-btn" type="button" data-modal-close>Fechar</button></div>`;
    modalEl.showModal();
    modalEl.querySelectorAll('[data-modal-close]').forEach(button => button.onclick = () => modalEl.close());
  }

  function openCardModal(board, column, card = null) {
    if (!canWrite() || !board || !column) return;
    const modalEl = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');
    if (!modalEl || !modalContent) return;

    const clients = currentClients();
    const clientOptions = [{value:'',label:'Sem cliente específico'},...clients.map(client=>({value:client.id,label:client.name}))];
    const selectedClient = clients.find(client=>String(client.id)===String(card?.clientId||''))?.name || (card?.clientId?'Cliente associado':'Sem cliente específico');

    modalContent.innerHTML = `
      <p class="eyebrow">ORGANIZAÇÃO · CARTÕES</p>
      <h2>${card ? 'Editar cartão' : 'Novo cartão'}</h2>
      <p class="muted">Coluna: <b>${esc(column.name)}</b>. Registre detalhes, cliente associado e prazo.</p>
      <div class="client-form">
        <div class="field full">
          <label for="card-modal-title">Título da tarefa / demanda</label>
          <input id="card-modal-title" maxlength="180" required autofocus value="${esc(card?.title || '')}" placeholder="Ex.: Criar carrossel institucional, Revisar pauta...">
        </div>
        <div class="field full">
          <label for="card-modal-desc">Descrição <small class="muted">(opcional)</small></label>
          <textarea id="card-modal-desc" maxlength="5000" placeholder="Orientações e contexto para quem vai produzir…">${esc(card?.description || '')}</textarea>
        </div>
        ${canReadClients() ? `
          <div class="field">
            <label for="card-modal-client">Cliente associado <small class="muted">(opcional)</small></label>
            <input id="card-modal-client" type="hidden" value="${esc(card?.clientId||'')}">
            ${selectMenu('card-client',selectedClient,clientOptions,'choose-card-client',{attrs:{'client-select':'1'},value:card?.clientId||''})}
          </div>
        ` : ''}
        <div class="field">
          <label for="card-modal-due">Data de entrega <small class="muted">(opcional)</small></label>
          <input id="card-modal-due" type="date" value="${esc(card?.dueDate ? String(card.dueDate).slice(0, 10) : '')}">
        </div>
        <div class="field full"><label>Etiquetas</label><div class="board-choice-grid">${(board.labels||[]).length ? board.labels.map(label=>`<label class="board-check-chip"><input type="checkbox" name="card-label" value="${esc(label.id)}" ${(card?.labels||[]).some(item=>item.id===label.id)?'checked':''}><span class="boards-label-chip" style="--label-color:${safeColor(label.color)}">${esc(label.name)}</span></label>`).join('') : '<small class="muted">Crie etiquetas pelo botão Etiquetas do quadro.</small>'}</div></div>
        <div class="field full"><label>Pessoas responsáveis</label><div class="board-choice-grid">${(board.members||[]).length ? board.members.map(member=>`<label class="board-person-option"><input type="checkbox" name="card-assignee" value="${esc(member.id)}" ${(card?.assignees||[]).some(item=>item.id===member.id)?'checked':''}><span class="board-avatar">${esc(member.name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase())}</span><span><b>${esc(member.name)}</b><small>${esc(member.role)}</small></span></label>`).join('') : '<small class="muted">Adicione pessoas em Equipe antes de atribuir cartões.</small>'}</div></div>
      </div>
      <div class="form-actions">
        <button class="secondary-btn" type="button" data-modal-close>Cancelar</button>
        <button class="primary-btn" type="button" id="submit-card-btn">${card ? 'Salvar alterações' : 'Criar cartão'}</button>
      </div>
    `;

    modalEl.showModal();
    modalEl.querySelectorAll('[data-modal-close]').forEach(b => b.onclick = () => modalEl.close());

    const submitBtn = document.getElementById('submit-card-btn');
    submitBtn.onclick = async () => {
      const title = document.getElementById('card-modal-title')?.value.trim();
      const description = document.getElementById('card-modal-desc')?.value.trim() || '';
      const clientId = document.getElementById('card-modal-client')?.value || null;
      const dueDate = document.getElementById('card-modal-due')?.value || null;
      const labelIds = [...modalContent.querySelectorAll('input[name="card-label"]:checked')].map(input=>input.value);
      const assigneeIds = [...modalContent.querySelectorAll('input[name="card-assignee"]:checked')].map(input=>input.value);

      if (!title) {
        callToast('Informe o título do cartão.', true);
        return;
      }

      submitBtn.disabled = true;
      try {
        const body = card
          ? { title, description, dueDate, labelIds, assigneeIds }
          : { columnId: column.id, title, description, labelIds, assigneeIds };

        if (canReadClients() && clientId) body.clientId = clientId;
        if (card && canReadClients() && !clientId) body.clientId = null;
        if (!card && dueDate) body.dueDate = dueDate;

        if (card) {
          await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(card.id)}`, putBody(body));
          callToast('Cartão atualizado.');
        } else {
          await apiCall(`/api/boards/${pathPart(board.id)}/cards`, requestBody(body));
          callToast('Cartão criado com sucesso.');
        }
        modalEl.close();
        await loadBoards(false);
      } catch (err) {
        callToast(err?.message || 'Erro ao salvar cartão.', true);
        submitBtn.disabled = false;
      }
    };
  }

  function openCardDetail(board,column,card){
    if(!board||!column||!card)return;
    if(scheduleEditingCardId&&scheduleEditingCardId!==card.id)scheduleEditingCardId='';
    const modalEl=document.getElementById('modal'),content=document.getElementById('modal-content');if(!modalEl||!content)return;
    const cover=(card.attachments||[]).find(item=>String(item.mimeType||'').startsWith('image/'));
    const done=(card.checklist||[]).filter(item=>item.completed).length;
    const clientOptions=[{value:'',label:'Sem cliente'},...currentClients().map(client=>({value:client.id,label:client.name}))];
    const statusOptions=sorted(board.columns.filter(item=>!item.archived)).map(item=>({value:item.id,label:item.name,color:item.color}));
    const imageAttachments=(card.attachments||[]).filter(item=>String(item.mimeType||'').startsWith('image/'));
    const scheduleClient=currentClients().find(item=>String(item.id)===String(card.clientId||''));
    const scheduleMode=cardScheduleModes[card.id]||(card.scheduleMode||((scheduleClient?.autoScheduleEnabled&&scheduleClient?.postingDays?.length)?'automatic':'manual'));
    const scheduleReady=Boolean(scheduleClient?.autoScheduleEnabled&&scheduleClient?.postingDays?.length);
    const zonedInput=value=>{if(!value)return'';const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));const o=Object.fromEntries(p.map(item=>[item.type,item.value]));return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;};
    const scheduledLabel=value=>{if(!value)return'';return new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'long',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));};
    const scheduleSection=column.workflowCategory!=='schedule'?'':!canReadClients()?`<section class="card-detail-section card-schedule-panel"><header><h3>${icon('calendar',16)} Programação</h3></header><p class="card-schedule-hint">Seu cargo precisa de acesso a clientes para programar publicações.</p></section>`:`<section class="card-detail-section card-schedule-panel"><header><h3>${icon('calendar',16)} Programar publicação</h3><span>Horário de Brasília</span></header>${!scheduleClient?`<p class="card-schedule-hint">Associe um cliente ao cartão para usar a agenda de publicação.</p>`:card.scheduledAt&&scheduleEditingCardId!==card.id?`<div class="card-schedule-booked"><span class="card-schedule-check">✓</span><div><b>Horário reservado</b><small>${esc(scheduledLabel(card.scheduledAt))} · ${card.scheduleMode==='automatic'?'Automático':'Manual'}</small><small>A reserva fica registrada no Social Ink; a publicação na rede ainda depende da integração.</small></div>${canWrite()?`<div class="card-schedule-actions"><button type="button" class="secondary-btn" data-action="edit-card-schedule" data-card-id="${esc(card.id)}">Alterar</button><button type="button" class="quiet-btn" data-action="clear-card-schedule" data-card-id="${esc(card.id)}">Cancelar</button></div>`:''}</div>`:`<div class="card-schedule-modes"><button type="button" class="card-schedule-mode ${scheduleMode==='automatic'?'active':''}" data-action="set-card-schedule-mode" data-card-id="${esc(card.id)}" data-mode="automatic" ${scheduleReady?'':'disabled'}><b>${icon('spark',15)} Automático</b><small>Próximo dia e horário livre da agenda do cliente</small></button><button type="button" class="card-schedule-mode ${scheduleMode==='manual'?'active':''}" data-action="set-card-schedule-mode" data-card-id="${esc(card.id)}" data-mode="manual"><b>${icon('calendar',15)} Manual</b><small>Escolha a data e o horário desta publicação</small></button></div>${scheduleMode==='automatic'?`<div class="card-schedule-config">${scheduleReady?`Agenda do cliente: <b>${scheduleClient.postingDays.map(esc).join(', ')}</b> às <b>${esc(scheduleClient.postingTime||'09:00')}</b>. O sistema reserva o próximo horário livre.`:`Ative o agendamento automático e escolha os dias em <b>Clientes → Editar cliente</b>.`}</div>`:`<label class="card-schedule-datetime">Data e horário<input type="datetime-local" id="card-schedule-datetime" value="${esc(zonedInput(card.scheduledAt))}" ${canWrite()?'':'disabled'}></label>`}${canWrite()?`<div class="card-schedule-actions"><button type="button" class="primary-btn" data-action="save-card-schedule" data-card-id="${esc(card.id)}" ${scheduleMode==='automatic'&&!scheduleReady?'disabled':''}>${card.scheduledAt?'Salvar alteração':'Reservar horário'}</button>${card.scheduledAt?`<button type="button" class="quiet-btn" data-action="cancel-edit-card-schedule" data-card-id="${esc(card.id)}">Voltar</button>`:''}</div>`:''}</section>`}`;
    const selectedLabelIds=new Set((card.labels||[]).map(item=>String(item.id)));
    const labelMenu=`<div class="card-picker si-select" data-select-id="card-labels-${esc(card.id)}"><button type="button" class="card-picker-trigger ${card.labels?.length?'is-compact':''}" data-action="toggle-menu" aria-haspopup="listbox" aria-expanded="false" title="Adicionar etiquetas">${card.labels?.length?'＋':'Etiquetas +'}</button><div class="si-select-menu card-picker-menu" role="listbox" hidden>${(board.labels||[]).length?board.labels.map(label=>`<button type="button" class="card-picker-option" role="option" aria-selected="${selectedLabelIds.has(String(label.id))}" data-action="toggle-card-label" data-card-id="${esc(card.id)}" data-label-id="${esc(label.id)}"><i class="si-option-dot" style="--option-color:${safeColor(label.color)}"></i><span>${esc(label.name)}</span>${selectedLabelIds.has(String(label.id))?'<b>✓</b>':'<b></b>'}</button>`).join(''):'<div class="card-picker-empty">Crie etiquetas nas opções do quadro para adicioná-las aqui.</div>'}</div></div>`;
    const assigneeMenu=(board.members||[]).length?`<div class="card-picker si-select" data-select-id="card-assignees-${esc(card.id)}"><button type="button" class="card-meta-edit" data-action="toggle-menu" aria-label="Adicionar ou remover responsáveis" aria-haspopup="listbox" aria-expanded="false">＋</button><div class="si-select-menu card-picker-menu" role="listbox" hidden>${board.members.map(member=>{const selected=(card.assignees||[]).some(person=>String(person.id)===String(member.id));return `<button type="button" class="card-picker-option card-member-option" role="option" aria-selected="${selected}" data-action="toggle-card-assignee" data-card-id="${esc(card.id)}" data-member-id="${esc(member.id)}"><span class="board-avatar" style="--profile-color:${safeColor(member.color||'#d8ff36')}">${profileAvatarMarkup(member)}</span><span class="card-member-option-copy"><b>${esc(member.name)}</b><small>${esc(member.role||'Colaborador')}</small></span><b>${selected?'✓':''}</b></button>`}).join('')}</div></div>`:'';
    const formatStamp=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(date)};
    const rightPane=cardDetailTab==='comments'?`
      <div class="card-discussion-list">${(card.comments||[]).length?(card.comments||[]).map(comment=>`<article class="card-comment"><button type="button" class="card-person-avatar" data-action="show-member" data-member-id="${esc(comment.userId)}" style="--profile-color:${safeColor(comment.color||'#d8ff36')}" aria-label="Ver perfil de ${esc(comment.userName)}">${profileAvatarMarkup({id:comment.userId,name:comment.userName,avatar:comment.avatar,color:comment.color})}</button><div><header><b style="color:${safeColor(comment.color||'#1d2825')}">${esc(comment.userName)}</b><time>${esc(formatStamp(comment.createdAt))}</time></header><p>${esc(comment.body)}</p></div></article>`).join(''):'<p class="card-panel-empty">Ainda não há comentários. Comece a conversa sobre este cartão.</p>'}</div>
      ${canWrite()?`<div class="card-comment-compose"><textarea id="card-comment-text" rows="2" placeholder="Escreva um comentário…"></textarea><button class="primary-btn" type="button" data-action="send-card-comment" data-card-id="${esc(card.id)}" aria-label="Enviar comentário">${icon('arrowRight',17)}</button></div>`:''}
    `:cardDetailTab==='activity'?`
      <div class="card-activity-list">${(card.activity||[]).length?(card.activity||[]).map(item=>`<article><span class="card-activity-mark"></span><div><b>${esc(item.userName)}</b> ${esc(item.detail||item.action)}<time>${esc(formatStamp(item.createdAt))}</time></div></article>`).join(''):'<p class="card-panel-empty">As alterações e ações deste cartão aparecerão aqui.</p>'}</div>
    `:cardDetailTab==='files'?`
      <div class="card-resource-list">${(card.attachments||[]).filter(item=>!item.url).map(item=>`<article><span class="card-resource-icon">${icon(String(item.mimeType||'').startsWith('image/')?'image':'file',17)}</span><div><a href="${esc(item.href)}" target="_blank" rel="noopener">${esc(item.originalName)}</a><small>${esc(item.mimeType||'Arquivo')}${item.size?` · ${(item.size/1024/1024).toFixed(1)} MB`:''}</small></div>${canWrite()?`<button class="boards-icon-btn is-danger" type="button" data-action="delete-card-attachment" data-card-id="${esc(card.id)}" data-attachment-id="${esc(item.id)}" aria-label="Remover anexo">${icon('trash',14)}</button>`:''}</article>`).join('')||'<p class="card-panel-empty">Nenhum arquivo anexado.</p>'}</div>
      ${canWrite()?`<label class="card-upload-inline">${icon('plus',16)} Adicionar arquivo<input type="file" data-action="upload-card-file" data-card-id="${esc(card.id)}" accept="image/*,.pdf,.mp4,.txt,.zip"></label>`:''}
    `:`
      <div class="card-resource-list">${(card.attachments||[]).filter(item=>item.url).map(item=>`<article><span class="card-resource-icon">${icon('link',17)}</span><div><a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.originalName)}</a><small>${esc(new URL(item.url).hostname)}</small></div>${canWrite()?`<button class="boards-icon-btn is-danger" type="button" data-action="delete-card-attachment" data-card-id="${esc(card.id)}" data-attachment-id="${esc(item.id)}" aria-label="Remover link">${icon('trash',14)}</button>`:''}</article>`).join('')||'<p class="card-panel-empty">Nenhum link salvo neste cartão.</p>'}</div>
      ${canWrite()?`<div class="card-link-compose"><input id="card-link-url" type="url" placeholder="https://…" aria-label="Link para anexar"><button class="primary-btn" type="button" data-action="add-card-link" data-card-id="${esc(card.id)}">Adicionar link</button></div>`:''}
    `;
    content.innerHTML=`<section class="card-detail-shell">
      <div class="card-detail-main">
        <div class="card-detail-heading-row"><div class="card-detail-heading-copy">
          ${canWrite()?selectMenu(`card-status-${card.id}`,column.name,statusOptions,'set-card-status',{icon:'board',attrs:{'card-id':card.id},value:column.id}):`<span class="card-status-readonly">${esc(column.name)}</span>`}
          ${canWrite()?`<input class="card-detail-title-input" id="card-detail-title" maxlength="180" value="${esc(card.title)}" aria-label="Título do cartão">`:`<h2 class="card-detail-title-static">${esc(card.title)}</h2>`}
          <div class="card-detail-labels">${(card.labels||[]).map(label=>`<span class="boards-label-chip" style="--label-color:${safeColor(label.color)}">${esc(label.name)}</span>`).join('')}${canWrite()?labelMenu:''}</div>
        </div>${cover?`<img class="card-detail-cover" src="${esc(cover.href)}" alt="Capa do cartão">`:''}</div>
        <div class="card-detail-meta">
          <section><label>Responsáveis</label><div class="card-meta-value">${card.assignees?.length?renderMemberAvatars(card.assignees,5):'<span class="muted">Ninguém atribuído</span>'}${canWrite()?assigneeMenu:''}</div></section>
          <section><label>Prazo</label><div class="card-meta-value">${canWrite()?`<input type="date" id="card-detail-due" data-action="save-card-due" data-card-id="${esc(card.id)}" value="${esc(card.dueDate?String(card.dueDate).slice(0,10):'')}" aria-label="Prazo do cartão">`:`${esc(dateLabel(card.dueDate)||'Sem prazo')}`}</div></section>
          <section><label>Cliente</label>${canReadClients()&&canWrite()?`<input id="card-detail-client" type="hidden" value="${esc(card.clientId||'')}">${selectMenu(`detail-client-${card.id}`,card.clientName||'Selecionar cliente',clientOptions,'choose-detail-client',{icon:'users',attrs:{'card-id':card.id},value:card.clientId||''})}`:`<div class="card-meta-value">${esc(card.clientName||'Sem cliente')}</div>`}</section>
        </div>
        <section class="card-detail-section"><header><h3>${icon('list',16)} Descrição</h3></header><textarea class="card-description-editor" id="card-detail-description" maxlength="5000" ${canWrite()?'':'readonly'} placeholder="Adicione contexto, instruções e referências para este cartão…">${esc(card.description||'')}</textarea>${canWrite()?`<button class="secondary-btn card-save-fields" type="button" data-action="save-card-fields" data-card-id="${esc(card.id)}">Salvar detalhes</button>`:''}</section>
        <section class="card-detail-section"><header><h3>${icon('checkSquare',16)} Checklist</h3><span class="card-check-progress">${done} de ${(card.checklist||[]).length}</span></header><div class="card-progress-track"><i style="width:${card.checklist?.length?Math.round(done/card.checklist.length*100):0}%"></i></div><div class="card-checklist">${(card.checklist||[]).map(item=>`<div class="card-check-item"><input type="checkbox" data-action="toggle-checklist" data-card-id="${esc(card.id)}" data-item-id="${esc(item.id)}" ${item.completed?'checked':''} ${canWrite()?'':'disabled'}><span>${esc(item.title)}</span>${canWrite()?`<button type="button" data-action="delete-checklist-item" data-card-id="${esc(card.id)}" data-item-id="${esc(item.id)}" aria-label="Remover item">${icon('close',13)}</button>`:''}</div>`).join('')}</div>${canWrite()?`<div class="card-check-add"><input id="card-check-new" maxlength="200" placeholder="Adicionar um item…"><button class="secondary-btn" type="button" data-action="add-checklist-item" data-card-id="${esc(card.id)}">＋ Adicionar</button></div>`:''}</section>
        <section class="card-detail-section"><header><h3>${icon('paperclip',16)} Anexos</h3><span>${(card.attachments||[]).length}</span></header><div class="card-attachment-grid">${imageAttachments.map(item=>`<a class="card-attachment-tile" href="${esc(item.href)}" target="_blank" rel="noopener"><img src="${esc(item.href)}" alt=""><b>${esc(item.originalName)}</b><small>${item.size?`${(item.size/1024/1024).toFixed(1)} MB`:'Imagem'}</small></a>`).join('')}${(card.attachments||[]).filter(item=>!String(item.mimeType||'').startsWith('image/')).map(item=>`<a class="card-attachment-tile card-file-tile" href="${esc(item.href||item.url)}" target="_blank" rel="noopener">${icon(item.url?'link':'file',22)}<b>${esc(item.originalName)}</b><small>${item.url?'Link':esc(item.mimeType||'Arquivo')}</small></a>`).join('')}${canWrite()?`<label class="card-attachment-add">${icon('plus',20)}<span>Adicionar anexo</span><input type="file" data-action="upload-card-file" data-card-id="${esc(card.id)}" accept="image/*,.pdf,.mp4,.txt,.zip"></label><button class="card-attachment-add" type="button" data-action="switch-card-tab" data-tab="links">${icon('link',20)}<span>Adicionar link</span></button>`:''}</div></section>
        ${scheduleSection}
      </div>
      <aside class="card-detail-discussion"><nav class="card-detail-tabs" role="tablist">${[['comments','Comentários'],['activity','Atividade'],['files','Arquivos'],['links','Links']].map(([id,label])=>`<button type="button" role="tab" aria-selected="${cardDetailTab===id}" class="${cardDetailTab===id?'active':''}" data-action="switch-card-tab" data-tab="${id}" data-card-id="${esc(card.id)}">${label}</button>`).join('')}</nav><div class="card-detail-tab-content">${rightPane}</div></aside>
      <div class="card-detail-toolbar"><button type="button" class="boards-icon-btn" data-action="archive-card" data-card-id="${esc(card.id)}" title="Arquivar cartão">${icon('archive',16)}</button><button type="button" class="boards-icon-btn" data-modal-close aria-label="Fechar cartão">${icon('close',17)}</button></div>
    </section>`;
    if(!modalEl.open)modalEl.showModal();
    modalEl.querySelectorAll('[data-modal-close]').forEach(button=>button.onclick=()=>modalEl.close());
  }

  async function refreshCardDetail(cardId,tab=cardDetailTab){
    cardDetailTab=tab;await loadBoards(false);const found=findCard(activeBoard(),cardId);if(found)openCardDetail(activeBoard(),found.column,found.card);
  }

  function openMembersModal(board) {
    const modalEl=document.getElementById('modal'), content=document.getElementById('modal-content'); if(!modalEl||!content)return;
    content.innerHTML=`<p class="eyebrow">EQUIPE DO QUADRO</p><h2>Pessoas</h2><div class="board-member-list">${(board.members||[]).map(member=>`<article class="board-member-row"><button type="button" class="board-profile-trigger" data-action="show-member" data-member-id="${esc(member.id)}"><span class="board-avatar board-avatar-large" style="--profile-color:${safeColor(member.color||'#d8ff36')}">${profileAvatarMarkup(member)}</span><span><b>${esc(member.name)}</b><small>${esc(member.role)}</small></span></button>${canWrite()?`<button class="boards-icon-btn is-danger" type="button" data-action="remove-member" data-member-id="${esc(member.id)}" title="Remover do quadro" aria-label="Remover ${esc(member.name)}">${icon('close',15)}</button>`:''}</article>`).join('')||'<p class="muted">Ainda não há pessoas neste quadro.</p>'}</div>${canWrite()&&(board.availableMembers||[]).length?`<div class="board-add-member"><label>Adicionar colaborador</label><div><input id="board-new-member" type="hidden" value="${esc(board.availableMembers[0].id)}">${selectMenu('board-new-member-select',`${board.availableMembers[0].name} · ${board.availableMembers[0].role}`,board.availableMembers.map(member=>({value:member.id,label:`${member.name} · ${member.role}`})),'choose-board-member',{value:board.availableMembers[0].id})}<button class="primary-btn" type="button" data-action="add-member">${icon('plus',15)} Adicionar</button></div></div>`:''}<div class="form-actions"><button class="secondary-btn" type="button" data-modal-close>Concluir</button></div>`;
    modalEl.showModal(); modalEl.querySelectorAll('[data-modal-close]').forEach(button=>button.onclick=()=>modalEl.close());
  }

  async function openMemberProfile(board, memberId) {
    let member=(board.members||[]).find(item=>String(item.id)===String(memberId))||(board.availableMembers||[]).find(item=>String(item.id)===String(memberId)); if(!member)return;
    let assigned=board.columns.flatMap(column=>column.cards.filter(card=>!card.archived&&card.assignees?.some(person=>person.id===member.id)).map(card=>({card,column})));
    try{const profile=await apiCall(`/api/users/${pathPart(memberId)}/profile`);member={...member,...profile.user};assigned=(profile.cards||[]).map(card=>({card,column:{name:`${card.board_name} · ${card.column_name}`,color:'#d8ff36'}}));}catch{}
    const modalEl=document.getElementById('modal'), content=document.getElementById('modal-content'); if(!modalEl||!content)return;
    content.innerHTML=`<div class="board-member-profile-cover cover-${member.cover||'lime'}"></div><div class="board-profile-hero" style="--profile-color:${safeColor(member.color||'#d8ff36')}"><span class="board-avatar board-avatar-profile" style="--profile-color:${safeColor(member.color||'#d8ff36')}">${profileAvatarMarkup(member)}</span><div><h2>${esc(member.name)}</h2><span class="board-role-pill" style="--role-color:${safeColor(member.roleColor||'#4946f5')}">${esc(member.role)}</span></div></div><section class="board-profile-section"><h3>Cartões atribuídos <span class="boards-tab-count">${assigned.length}</span></h3>${assigned.length?`<div class="board-profile-tasks">${assigned.map(({card,column})=>`<article><span class="board-column-dot" style="--column-color:${safeColor(column.color)}"></span><span><b>${esc(card.title)}</b><small>${esc(column.name)}${card.clientName?` · ${esc(card.clientName)}`:''}</small></span></article>`).join('')}</div>`:'<p class="board-empty-note">Nenhum cartão atribuído neste quadro.</p>'}</section><div class="form-actions"><button class="secondary-btn" type="button" data-modal-close>Fechar</button></div>`;
    modalEl.showModal(); modalEl.querySelectorAll('[data-modal-close]').forEach(button=>button.onclick=()=>modalEl.close());
  }

  function openLabelsModal(board, label = null) {
    if(!canWrite())return;
    const modalEl=document.getElementById('modal'), content=document.getElementById('modal-content'); if(!modalEl||!content)return;
    content.innerHTML=`<p class="eyebrow">ORGANIZAÇÃO · ETIQUETAS</p><h2>${label?'Editar etiqueta':'Etiquetas do quadro'}</h2><p class="muted">Use cores para sinalizar tipos de entrega, campanhas, prioridade ou revisão.</p><div class="board-label-manager">${(board.labels||[]).map(item=>`<div class="board-label-row"><span class="boards-label-chip" style="--label-color:${safeColor(item.color)}">${esc(item.name)}</span><span class="board-label-row-actions"><button class="boards-icon-btn" type="button" data-action="edit-label" data-label-id="${esc(item.id)}" title="Editar etiqueta">${icon('edit',14)}</button><button class="boards-icon-btn is-danger" type="button" data-action="delete-label" data-label-id="${esc(item.id)}" title="Excluir etiqueta">${icon('trash',14)}</button></span></div>`).join('')||'<p class="board-empty-note">Crie etiquetas para deixar os cartões mais fáceis de identificar.</p>'}</div><div class="board-label-form"><label for="board-label-name">${label?'Nome da etiqueta':'Nova etiqueta'}</label><div class="board-label-form-fields"><input id="board-label-name" maxlength="40" value="${esc(label?.name||'')}" placeholder="Ex.: Campanha, Revisão, Prioridade"><input id="board-label-color" type="color" value="${safeColor(label?.color||'#4946f5')}" aria-label="Cor da etiqueta"><button class="primary-btn" type="button" data-action="save-label" data-label-id="${esc(label?.id||'')}">${label?'Salvar':'Criar etiqueta'}</button></div></div><div class="form-actions"><button class="secondary-btn" type="button" data-modal-close>Concluir</button></div>`;
    modalEl.showModal(); modalEl.querySelectorAll('[data-modal-close]').forEach(button=>button.onclick=()=>modalEl.close());
  }

  async function saveBoardLabel(labelId = '') {
    const board=activeBoard(); if(!board)return;
    const name=document.getElementById('board-label-name')?.value.trim(); const color=document.getElementById('board-label-color')?.value;
    if(!name){callToast('Dê um nome para a etiqueta.',true);return;}
    try{
      const path=`/api/boards/${pathPart(board.id)}/labels${labelId?`/${pathPart(labelId)}`:''}`;
      await apiCall(path,labelId?putBody({name,color}):requestBody({name,color}));
      const modalEl=document.getElementById('modal'); modalEl?.close(); callToast(labelId?'Etiqueta atualizada.':'Etiqueta criada.'); await loadBoards(false); if(activeBoard())openLabelsModal(activeBoard());
    }catch(error){callToast(error?.message||'Não foi possível salvar a etiqueta.',true);}
  }

  async function deleteBoardLabel(labelId) {
    const board=activeBoard(); if(!board)return;
    if(!confirm('Excluir esta etiqueta? Ela será removida dos cartões deste quadro.'))return;
    try{await apiCall(`/api/boards/${pathPart(board.id)}/labels/${pathPart(labelId)}`,{method:'DELETE'});document.getElementById('modal')?.close();callToast('Etiqueta removida.');await loadBoards(false);if(activeBoard())openLabelsModal(activeBoard());}
    catch(error){callToast(error?.message||'Não foi possível remover a etiqueta.',true);}
  }

  async function changeBoardMember(userId, add) {
    const board=activeBoard(); if(!board)return;
    try{
      const url=`/api/boards/${pathPart(board.id)}/members${add?'':`/${pathPart(userId)}`}`;
      await apiCall(url,add?requestBody({userId}):{method:'DELETE'});
      document.getElementById('modal')?.close();callToast(add?'Pessoa adicionada ao quadro.':'Pessoa removida do quadro.'); await loadBoards(false); if(activeBoard())openMembersModal(activeBoard());
    }catch(error){callToast(error?.message||'Não foi possível atualizar a equipe.',true);}
  }

  function findColumn(board, columnId) {
    return board?.columns?.find(column => String(column.id) === String(columnId)) || null;
  }

  function findCard(board, cardId) {
    for (const column of board?.columns || []) {
      const card = column.cards?.find(item => String(item.id) === String(cardId));
      if (card) return { card, column };
    }
    return null;
  }

  function bindEvents() {
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeyDown);
    const modalContent=document.getElementById('modal-content');
    modalContent?.addEventListener('click', onClick);
    modalContent?.addEventListener('change', onChange);
    modalContent?.addEventListener('input', onInput);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend', onDragEnd);
  }

  async function onClick(event) {
    if(!event.target.closest('.si-select'))document.querySelectorAll('.si-select.is-open').forEach(menu=>{menu.classList.remove('is-open');const list=menu.querySelector('.si-select-menu');if(list)list.hidden=true;menu.querySelector('.si-select-trigger')?.setAttribute('aria-expanded','false');});
    const button = event.target.closest('[data-action]');
    if (!button || (!root.contains(button) && !button.closest('#modal-content'))) return;
    const action = button.dataset.action;

    if(action==='toggle-menu'){
      const select=button.closest('.si-select');if(!select)return;
      document.querySelectorAll('.si-select.is-open').forEach(menu=>{if(menu!==select){menu.classList.remove('is-open');menu.querySelector('.si-select-menu').hidden=true;menu.querySelector('.si-select-trigger')?.setAttribute('aria-expanded','false');}});
      const list=select.querySelector('.si-select-menu'),isOpening=list.hidden;list.hidden=!isOpening;select.classList.toggle('is-open',isOpening);button.setAttribute('aria-expanded',String(isOpening));
      if(isOpening){const rect=button.getBoundingClientRect(),naturalWidth=parseFloat(getComputedStyle(list).width)||190,width=Math.max(rect.width,naturalWidth),height=Math.min(list.scrollHeight||240,270),left=Math.max(8,Math.min(rect.left,window.innerWidth-width-8)),top=rect.bottom+height+8<window.innerHeight?rect.bottom+7:Math.max(8,rect.top-height-7);list.style.position='fixed';list.style.left=`${left}px`;list.style.top=`${top}px`;list.style.minWidth=`${width}px`;list.style.maxWidth=`${Math.max(220,window.innerWidth-16)}px`;}
      else{list.style.removeProperty('position');list.style.removeProperty('left');list.style.removeProperty('top');list.style.removeProperty('min-width');list.style.removeProperty('max-width');}
      return;
    }
    if(action==='toggle-column-submenu'){
      const select=button.closest('.column-actions-select'),submenu=select?.querySelector(`[data-column-submenu="${button.dataset.submenu}"]`);if(!submenu)return;
      select.querySelectorAll('.column-submenu').forEach(item=>{if(item!==submenu){item.hidden=true;const trigger=select.querySelector(`[data-submenu="${item.dataset.columnSubmenu}"]`);trigger?.setAttribute('aria-expanded','false');}});
      submenu.hidden=!submenu.hidden;
      button.setAttribute('aria-expanded',String(!submenu.hidden));
      if(!submenu.hidden){const rect=button.getBoundingClientRect(),width=240,height=Math.min(submenu.scrollHeight||180,300),left=rect.right+width+10<window.innerWidth?rect.right+7:Math.max(8,rect.left-width-7),top=Math.max(8,Math.min(rect.top,window.innerHeight-height-8));submenu.style.position='fixed';submenu.style.left=`${left}px`;submenu.style.top=`${top}px`;submenu.style.maxHeight='min(300px, calc(100vh - 16px))';}
      else{submenu.style.removeProperty('position');submenu.style.removeProperty('left');submenu.style.removeProperty('top');submenu.style.removeProperty('max-height');}
      return;
    }
    if(action==='move-all-cards'){
      await moveAllColumnCards(button.dataset.columnId,button.dataset.targetColumnId);return;
    }
    if(action==='sort-column-cards'){
      await sortColumnCards(button.dataset.columnId,button.dataset.sortMode);return;
    }
    if(action==='set-column-color'){
      await setColumnColor(button.dataset.columnId,button.dataset.color);return;
    }
    if(action==='set-column-category'){
      await setColumnCategory(button.dataset.columnId,button.dataset.category||'');return;
    }
    if(action==='archive-column-cards'){
      await archiveAllColumnCards(button.dataset.columnId);return;
    }
    if(action==='choose-filter'){
      const field=button.dataset.filter,value=button.dataset.value;
      if(field==='client')filterClientId=value;if(field==='member')filterMemberId=value;if(field==='label')filterLabelId=value;if(field==='due')filterDue=value;
      render();return;
    }
    if(action==='new-card'){
      if(!canWrite())return;
      newCardDraftColumnId=button.dataset.columnId||'';render();
      requestAnimationFrame(()=>root.querySelector('.boards-inline-card-title')?.focus());return;
    }
    if(action==='cancel-inline-card'){
      newCardDraftColumnId='';render();return;
    }
    if(action==='submit-inline-card'){
      await submitInlineCard(button.dataset.columnId);return;
    }
    if(action==='choose-card-client'){
      const input=document.getElementById('card-modal-client');if(input)input.value=button.dataset.value;
      const label=button.closest('.si-select')?.querySelector('.si-select-trigger span');if(label)label.textContent=button.querySelector('span')?.textContent||'Sem cliente específico';
      const menu=button.closest('.si-select');menu?.classList.remove('is-open');menu?.querySelector('.si-select-menu')?.setAttribute('hidden','');menu?.querySelector('.si-select-trigger')?.setAttribute('aria-expanded','false');return;
    }
    if(action==='choose-board-member'){
      const input=document.getElementById('board-new-member');if(input)input.value=button.dataset.value;
      const menu=button.closest('.si-select'),label=menu?.querySelector('.si-select-trigger span');if(label)label.textContent=button.querySelector('span')?.textContent||'Escolha uma pessoa';
      menu?.classList.remove('is-open');menu?.querySelector('.si-select-menu')?.setAttribute('hidden','');menu?.querySelector('.si-select-trigger')?.setAttribute('aria-expanded','false');return;
    }
    if(action==='choose-detail-client'){
      const cardId=button.dataset.cardId,board=activeBoard(),value=button.dataset.value;const found=findCard(board,cardId);if(!canWrite()||!board||!found)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}`,putBody({clientId:value||null}));await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível alterar o cliente.',true);}return;
    }
    if(action==='toggle-card-label'){
      const board=activeBoard(),cardId=button.dataset.cardId,labelId=button.dataset.labelId,found=findCard(board,cardId);if(!canWrite()||!board||!found)return;
      const labelIds=new Set((found.card.labels||[]).map(item=>String(item.id)));if(labelIds.has(String(labelId)))labelIds.delete(String(labelId));else labelIds.add(String(labelId));
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}`,putBody({labelIds:[...labelIds]}));await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível atualizar as etiquetas.',true);}return;
    }
    if(action==='toggle-card-assignee'){
      const board=activeBoard(),cardId=button.dataset.cardId,memberId=button.dataset.memberId,found=findCard(board,cardId);if(!canWrite()||!board||!found)return;
      const assigneeIds=new Set((found.card.assignees||[]).map(item=>String(item.id)));if(assigneeIds.has(String(memberId)))assigneeIds.delete(String(memberId));else assigneeIds.add(String(memberId));
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}`,putBody({assigneeIds:[...assigneeIds]}));await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível atualizar os responsáveis.',true);}return;
    }
    if(action==='set-card-status'){
      const board=activeBoard(),found=findCard(board,button.dataset.cardId),target=findColumn(board,button.dataset.value);if(!canWrite()||!found||!target)return;
      document.getElementById('modal')?.close();await moveCard(found.card.id,target.id,target.cards.filter(item=>!item.archived).length);const latest=findCard(activeBoard(),found.card.id);if(latest)openCardDetail(activeBoard(),latest.column,latest.card);return;
    }
    if(action==='open-card'){
      const board=activeBoard(),found=findCard(board,button.dataset.cardId);if(found){cardDetailTab='comments';openCardDetail(board,found.column,found.card);}return;
    }
    if(action==='switch-card-tab'){
      const board=activeBoard(),cardId=document.querySelector('#modal-content [data-card-id]')?.dataset.cardId||button.closest('[data-card-id]')?.dataset.cardId;
      cardDetailTab=button.dataset.tab;const found=cardId&&findCard(board,cardId);if(found)openCardDetail(board,found.column,found.card);return;
    }
    if(action==='save-card-fields'){
      const board=activeBoard(),cardId=button.dataset.cardId;if(!board)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}`,putBody({title:document.getElementById('card-detail-title')?.value.trim(),description:document.getElementById('card-detail-description')?.value.trim()||''}));callToast('Detalhes salvos.');await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível salvar os detalhes.',true);}return;
    }
    if(action==='edit-card-schedule'){
      const cardId=button.dataset.cardId,found=findCard(activeBoard(),cardId);if(!found)return;
      scheduleEditingCardId=cardId;cardScheduleModes[cardId]=found.card.scheduleMode||'manual';openCardDetail(activeBoard(),found.column,found.card);return;
    }
    if(action==='cancel-edit-card-schedule'){
      scheduleEditingCardId='';const found=findCard(activeBoard(),button.dataset.cardId);if(found)openCardDetail(activeBoard(),found.column,found.card);return;
    }
    if(action==='set-card-schedule-mode'){
      const cardId=button.dataset.cardId,found=findCard(activeBoard(),cardId);if(!found)return;
      scheduleEditingCardId=cardId;cardScheduleModes[cardId]=button.dataset.mode;const scroll=modalContent?.querySelector('.card-detail-main')?.scrollTop||0;openCardDetail(activeBoard(),found.column,found.card);requestAnimationFrame(()=>{const main=modalContent?.querySelector('.card-detail-main');if(main)main.scrollTop=scroll;});return;
    }
    if(action==='save-card-schedule'){
      const board=activeBoard(),cardId=button.dataset.cardId,mode=cardScheduleModes[cardId]||(findCard(board,cardId)?.card.scheduleMode==='automatic'?'automatic':'manual');if(!board)return;
      const body={mode};if(mode==='manual')body.scheduledAt=document.getElementById('card-schedule-datetime')?.value||'';
      button.disabled=true;try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/schedule`,requestBody(body));scheduleEditingCardId='';delete cardScheduleModes[cardId];callToast('Horário reservado no calendário do cliente. A publicação ainda depende da integração com a rede social.');await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível reservar esse horário.',true);button.disabled=false;}return;
    }
    if(action==='clear-card-schedule'){
      const board=activeBoard(),cardId=button.dataset.cardId;if(!board)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/schedule`,requestBody({mode:'clear'}));scheduleEditingCardId='';delete cardScheduleModes[cardId];callToast('Agendamento cancelado.');await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível cancelar o agendamento.',true);}return;
    }
    if(action==='send-card-comment'){
      const board=activeBoard(),cardId=button.dataset.cardId,body=document.getElementById('card-comment-text')?.value.trim();if(!board||!body)return;
      button.disabled=true;try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/comments`,requestBody({body}));await refreshCardDetail(cardId,'comments');}catch(error){callToast(error?.message||'Não foi possível enviar o comentário.',true);button.disabled=false;}return;
    }
    if(action==='add-checklist-item'){
      const board=activeBoard(),cardId=button.dataset.cardId,title=document.getElementById('card-check-new')?.value.trim();if(!board||!title)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/checklist`,requestBody({title}));await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível adicionar o item.',true);}return;
    }
    if(action==='delete-checklist-item'){
      const board=activeBoard(),cardId=button.dataset.cardId,itemId=button.dataset.itemId;if(!board)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/checklist/${pathPart(itemId)}`,{method:'DELETE'});await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível remover o item.',true);}return;
    }
    if(action==='add-card-link'){
      const board=activeBoard(),cardId=button.dataset.cardId,url=document.getElementById('card-link-url')?.value.trim();if(!board||!url)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/attachments`,requestBody({url}));await refreshCardDetail(cardId,'links');}catch(error){callToast(error?.message||'Não foi possível adicionar o link.',true);}return;
    }
    if(action==='delete-card-attachment'){
      const board=activeBoard(),cardId=button.dataset.cardId,attachmentId=button.dataset.attachmentId;if(!board)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/attachments/${pathPart(attachmentId)}`,{method:'DELETE'});await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível remover o anexo.',true);}return;
    }

    if (action === 'new-board') {
      openCreateBoardModal();
      return;
    }
    if (action === 'select-board') {
      activeBoardId = button.dataset.boardId;
      newCardDraftColumnId = '';
      showingArchivedBoards = false;
      showingArchivedCards = false;
      render();
      return;
    }
    if (action === 'back-to-menu') {
      activeBoardId = null;
      newCardDraftColumnId = '';
      render();
      return;
    }
    if (action === 'tab-active-boards') {
      showingArchivedBoards = false;
      render();
      return;
    }
    if (action === 'tab-archived-boards') {
      showingArchivedBoards = true;
      render();
      return;
    }
    if (action === 'toggle-card-archive') {
      showingArchivedCards = !showingArchivedCards;
      render();
      return;
    }
    if(action==='clear-filters'){
      filterClientId='';filterMemberId='';filterLabelId='';filterDue='';filterCardText='';render();return;
    }
    if(action==='toggle-view'){
      listView=button.dataset.view==='list';render();return;
    }
    if(action==='manage-members'){const board=activeBoard();if(board){if(button.closest('#modal-content'))document.getElementById('modal')?.close();openMembersModal(board);}return;}
    if(action==='show-member'){const board=activeBoard();if(board){document.getElementById('modal')?.close();openMemberProfile(board,button.dataset.memberId);}return;}
    if(action==='add-member'){const id=document.getElementById('board-new-member')?.value;if(id)changeBoardMember(id,true);return;}
    if(action==='remove-member'){if(confirm('Remover esta pessoa do quadro? Os cartões atribuídos a ela ficarão sem responsável.'))changeBoardMember(button.dataset.memberId,false);return;}
    if(action==='manage-labels'){const board=activeBoard();if(board){if(button.closest('#modal-content'))document.getElementById('modal')?.close();openLabelsModal(board);}return;}
    if(action==='board-options'){const board=activeBoard();if(board)openBoardOptionsModal(board);return;}
    if(action==='reset-board'){resetBoard(button.dataset.boardId);return;}
    if(action==='edit-label'){const board=activeBoard();const label=board?.labels.find(item=>item.id===button.dataset.labelId);if(board&&label){document.getElementById('modal')?.close();openLabelsModal(board,label);}return;}
    if(action==='save-label'){saveBoardLabel(button.dataset.labelId);return;}
    if(action==='delete-label'){deleteBoardLabel(button.dataset.labelId);return;}
    if (action === 'retry') {
      loadBoards(true);
      return;
    }
    if (action === 'edit-board') {
      const board = boards.find(item => String(item.id) === String(button.dataset.boardId));
      if (board) { if(button.closest('#modal-content'))document.getElementById('modal')?.close(); openEditBoardModal(board); }
      return;
    }
    if (action === 'archive-board') {
      if(button.closest('#modal-content'))document.getElementById('modal')?.close();
      archiveBoard(button.dataset.boardId);
      return;
    }
    if (action === 'restore-board') {
      setBoardArchived(button.dataset.boardId, false);
      return;
    }
    if (action === 'new-column') {
      const board = activeBoard();
      if (board) { if(button.closest('#modal-content'))document.getElementById('modal')?.close(); openColumnModal(board); }
      return;
    }
    if (action === 'edit-column') {
      const board = activeBoard();
      const column = findColumn(board, button.dataset.columnId);
      if (board && column) openColumnModal(board, column);
      return;
    }
    if (action === 'archive-column') {
      archiveColumn(button.dataset.columnId);
      return;
    }
    if (action === 'restore-column') {
      setColumnArchived(button.dataset.columnId, false);
      return;
    }
    if (action === 'shift-column') {
      shiftColumn(button.dataset.columnId, button.dataset.direction);
      return;
    }
    if (action === 'archive-card') {
      if(button.closest('#modal-content'))document.getElementById('modal')?.close();
      archiveCard(button.dataset.cardId);
      return;
    }
    if (action === 'restore-card') {
      setCardArchived(button.dataset.cardId, false);
      return;
    }
    if (action === 'shift-card') {
      shiftCard(button.dataset.cardId, button.dataset.columnId, button.dataset.direction);
      return;
    }
  }

  async function archiveBoard(boardId) {
    if (!canWrite()) return;
    if (!confirm('Arquivar este quadro? Você poderá encontrá-lo e restaurá-lo na aba Arquivados.')) return;
    await setBoardArchived(boardId, true);
  }

  async function setBoardArchived(boardId, archived) {
    try {
      await apiCall(`/api/boards/${pathPart(boardId)}`, putBody({ archived }));
      callToast(archived ? 'Quadro arquivado com sucesso.' : 'Quadro restaurado com sucesso.');
      if (archived && String(activeBoardId) === String(boardId)) {
        activeBoardId = null;
      }
      await loadBoards(false);
    } catch (err) {
      callToast(err?.message || 'Erro ao atualizar quadro.', true);
    }
  }

  async function archiveColumn(columnId) {
    const board = activeBoard();
    const column = findColumn(board, columnId);
    if (!board || !column) return;
    if (!confirm(`Excluir a coluna “${column.name}”? Os cartões serão preservados no arquivo e voltarão se a coluna for restaurada.`)) return;
    document.getElementById('modal')?.close();
    await setColumnArchived(columnId, true);
  }

  async function setColumnArchived(columnId, archived) {
    const board = activeBoard();
    if (!board) return;
    const column = findColumn(board, columnId);
    if (!column) return;
    try {
      await apiCall(`/api/boards/${pathPart(board.id)}/columns/${pathPart(columnId)}`, putBody({ archived }));
      callToast(archived ? 'Coluna arquivada.' : 'Coluna restaurada.');
      await loadBoards(false);
    } catch (err) {
      callToast(err?.message || 'Erro ao atualizar coluna.', true);
    }
  }

  async function resetBoard(boardId) {
    const board = activeBoard();
    if (!canWrite() || !board || String(board.id) !== String(boardId)) return;
    if (!confirm(`Reiniciar “${board.name}”? Os cartões e colunas atuais serão guardados no arquivo e um novo fluxo vazio será criado.`)) return;
    try {
      await apiCall(`/api/boards/${pathPart(board.id)}/reset`, requestBody({}));
      document.getElementById('modal')?.close();
      filterClientId='';filterMemberId='';filterLabelId='';filterDue='';filterCardText='';
      callToast('Quadro reiniciado. O fluxo anterior foi preservado no arquivo.');
      await loadBoards(false);
    } catch (err) {
      callToast(err?.message || 'Não foi possível reiniciar o quadro.', true);
    }
  }

  async function archiveCard(cardId) {
    await setCardArchived(cardId, true);
  }

  async function setCardArchived(cardId, archived) {
    const board = activeBoard();
    if (!board) return;
    try {
      await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}`, putBody({ archived }));
      callToast(archived ? 'Cartão arquivado.' : 'Cartão restaurado.');
      await loadBoards(false);
    } catch (err) {
      callToast(err?.message || 'Erro ao atualizar cartão.', true);
    }
  }

  async function moveAllColumnCards(sourceColumnId,targetColumnId){
    const board=activeBoard(),source=findColumn(board,sourceColumnId),target=findColumn(board,targetColumnId);if(!canWrite()||!board||!source||!target)return;
    const cards=sorted(source.cards.filter(card=>!card.archived));if(!cards.length)return;
    try{
      const start=target.cards.filter(card=>!card.archived).length;
      for(let index=0;index<cards.length;index++)await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cards[index].id)}/move`,requestBody({columnId:target.id,position:start+index}));
      setColumnSortMode(board.id,source.id,'manual');setColumnSortMode(board.id,target.id,'manual');callToast(`${cards.length} ${cards.length===1?'cartão movido':'cartões movidos'} para “${target.name}”.`);await loadBoards(false);
    }catch(error){callToast(error?.message||'Não foi possível mover todos os cartões.',true);await loadBoards(false);}
  }

  async function sortColumnCards(columnId,mode){
    const board=activeBoard(),column=findColumn(board,columnId);if(!canWrite()||!board||!column)return;
    const cards=sorted(column.cards.filter(card=>!card.archived));
    if(mode==='created-desc')cards.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    else if(mode==='created-asc')cards.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
    else if(mode==='name-asc')cards.sort((a,b)=>String(a.title||'').localeCompare(String(b.title||''),'pt-BR',{sensitivity:'base'}));
    const labels={manual:'Ordem manual','created-desc':'Data de criação (mais recente primeiro)','created-asc':'Data de criação (mais antigo primeiro)','name-asc':'Nome do cartão (ordem alfabética)'};
    try{
      for(let index=0;index<cards.length;index++)await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cards[index].id)}/move`,requestBody({columnId:column.id,position:index}));
      setColumnSortMode(board.id,column.id,mode);callToast(`Lista ordenada: ${labels[mode]||labels.manual}.`);await loadBoards(false);
    }catch(error){callToast(error?.message||'Não foi possível ordenar a lista.',true);await loadBoards(false);}
  }

  async function setColumnColor(columnId,color){
    const board=activeBoard(),column=findColumn(board,columnId);if(!canWrite()||!board||!column||!/^#[\da-f]{6}$/i.test(String(color||'')))return;
    try{await apiCall(`/api/boards/${pathPart(board.id)}/columns/${pathPart(column.id)}`,putBody({color}));callToast('Cor da lista atualizada.');await loadBoards(false);}
    catch(error){callToast(error?.message||'Não foi possível alterar a cor da lista.',true);}
  }

  async function setColumnCategory(columnId,workflowCategory){
    const board=activeBoard(),column=findColumn(board,columnId);if(!canWrite()||!board||!column)return;
    const usedBy=board.columns.find(item=>!item.archived&&String(item.id)!==String(column.id)&&item.workflowCategory===workflowCategory);
    if(workflowCategory&&usedBy){callToast(`Essa categoria já está sendo usada em “${usedBy.name}”.`,true);return;}
    try{await apiCall(`/api/boards/${pathPart(board.id)}/columns/${pathPart(column.id)}`,putBody({workflowCategory}));const label=workflowCategories.find(([key])=>key===workflowCategory)?.[1]||'Sem categoria';callToast(`Categoria da coluna: ${label}.`);await loadBoards(false);}
    catch(error){callToast(error?.message||'Não foi possível categorizar a coluna.',true);await loadBoards(false);}
  }

  async function archiveAllColumnCards(columnId){
    const board=activeBoard(),column=findColumn(board,columnId);if(!canWrite()||!board||!column)return;
    const cards=column.cards.filter(card=>!card.archived);if(!cards.length)return;
    if(!confirm(`Arquivar todos os ${cards.length} cartões de “${column.name}”? Você poderá restaurá-los no arquivo.`))return;
    try{
      for(const card of cards)await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(card.id)}`,putBody({archived:true}));
      callToast(`${cards.length} ${cards.length===1?'cartão arquivado':'cartões arquivados'}.`);await loadBoards(false);
    }catch(error){callToast(error?.message||'Não foi possível arquivar todos os cartões.',true);await loadBoards(false);}
  }

  async function shiftColumn(columnId, direction) {
    const board = activeBoard();
    if (!board) return;
    const columns = sorted(board.columns.filter(column => !column.archived));
    const index = columns.findIndex(column => String(column.id) === String(columnId));
    const target = index + (direction === 'left' ? -1 : 1);
    if (index < 0 || target < 0 || target >= columns.length) return;
    [columns[index], columns[target]] = [columns[target], columns[index]];
    await saveColumnOrder(board, columns);
  }

  async function saveColumnOrder(board, columns) {
    try {
      await apiCall(`/api/boards/${pathPart(board.id)}/columns/reorder`, requestBody({ columnIds: columns.map(column => String(column.id)) }));
      callToast('Ordem das colunas atualizada.');
      await loadBoards(false);
    } catch (error) {
      callToast(error?.message || 'Não foi possível reordenar as colunas.', true);
    }
  }

  async function shiftCard(cardId, columnId, direction) {
    const board = activeBoard();
    const column = findColumn(board, columnId);
    if (!board || !column) return;
    const cards = sorted(column.cards.filter(card => !card.archived));
    const index = cards.findIndex(card => String(card.id) === String(cardId));
    const target = index + (direction === 'up' ? -1 : 1);
    if (index < 0 || target < 0 || target >= cards.length) return;
    await moveCard(cardId, column.id, target);
  }

  async function moveCard(cardId, columnId, position) {
    const board = activeBoard();
    if (!board) return;
    const source=findCard(board,cardId)?.column;
    try {
      await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/move`, requestBody({ columnId, position }));
      setColumnSortMode(board.id,columnId,'manual');if(source)setColumnSortMode(board.id,source.id,'manual');
      await loadBoards(false);
    } catch (error) {
      callToast(error?.message || 'Não foi possível mover o cartão.', true);
    }
  }

  async function submitInlineCard(columnId){
    const board=activeBoard(),column=findColumn(board,columnId),input=root.querySelector(`.boards-inline-card-title[data-column-id="${CSS.escape(String(columnId))}"]`),title=input?.value.trim();
    if(!canWrite()||!board||!column)return;
    if(!title){input?.classList.add('is-invalid');input?.focus();return;}
    const button=root.querySelector(`[data-action="submit-inline-card"][data-column-id="${CSS.escape(String(columnId))}"]`);if(button)button.disabled=true;
    try{
      await apiCall(`/api/boards/${pathPart(board.id)}/cards`,requestBody({columnId:column.id,title}));
      newCardDraftColumnId='';callToast('Cartão criado.');await loadBoards(false);
    }catch(error){
      callToast(error?.message||'Não foi possível criar o cartão.',true);if(button)button.disabled=false;input?.focus();
    }
  }

  function onKeyDown(event){
    const input=event.target.closest('.boards-inline-card-title');if(!input)return;
    if(event.key==='Enter'){event.preventDefault();submitInlineCard(input.dataset.columnId);}
    if(event.key==='Escape'){event.preventDefault();newCardDraftColumnId='';render();}
  }

  async function onChange(event) {
    const checklist=event.target.closest('[data-action="toggle-checklist"]');
    if(checklist){
      const board=activeBoard(),cardId=checklist.dataset.cardId,itemId=checklist.dataset.itemId;if(!board)return;
      try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/checklist/${pathPart(itemId)}`,putBody({completed:checklist.checked}));await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível atualizar a checklist.',true);}return;
    }
    const dueInput=event.target.closest('[data-action="save-card-due"]');
    if(dueInput){const board=activeBoard(),cardId=dueInput.dataset.cardId;if(!board)return;try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}`,putBody({dueDate:dueInput.value||null}));await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível salvar o prazo.',true);}return;}
    const uploadInput=event.target.closest('[data-action="upload-card-file"]');
    if(uploadInput){const file=uploadInput.files?.[0],board=activeBoard(),cardId=uploadInput.dataset.cardId;if(!file||!board)return;if(file.size>12*1024*1024){callToast('O arquivo deve ter até 12 MB.',true);uploadInput.value='';return;}try{await apiCall(`/api/boards/${pathPart(board.id)}/cards/${pathPart(cardId)}/attachments?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'content-type':file.type},body:file});callToast('Arquivo anexado.');await refreshCardDetail(cardId);}catch(error){callToast(error?.message||'Não foi possível anexar o arquivo.',true);}return;}
    const select = event.target.closest('[data-action="move-card-select"]');
    if (!canWrite() || !select || !select.value) return;
    const cardId = select.dataset.cardId;
    const targetColumnId = select.value;
    select.value = '';
    const board = activeBoard();
    const targetColumn = findColumn(board, targetColumnId);
    if (!board || !targetColumn) return;
    const position = targetColumn.cards.filter(c => !c.archived).length;
    await moveCard(cardId, targetColumnId, position);
  }

  function onInput(event){
    const draftTitle=event.target.closest('.boards-inline-card-title');if(draftTitle){draftTitle.classList.remove('is-invalid');return;}
    const search=event.target.closest('[data-action="search-cards"]');
    if(!search)return;
    filterCardText=search.value;
    render();
  }

  /* Drag and Drop */

  function onDragStart(event) {
    if (!canWrite()) return;
    const card = event.target.closest('[data-card-id]');
    if (card && root.contains(card)) {
      draggedCardId = card.dataset.cardId;
      card.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggedCardId);
      }
      return;
    }
    const column = event.target.closest('[data-drag-column]');
    if (!column || !root.contains(column)) return;
    draggedColumnId = column.dataset.dragColumn;
    column.classList.add('is-column-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `column:${draggedColumnId}`);
    }
  }

  function onDragOver(event) {
    if (!canWrite()) return;
    if (draggedColumnId) {
      const target = event.target.closest('[data-drag-column]');
      if (!target || !root.contains(target)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.boards-column.is-column-drop-target').forEach(item => item.classList.remove('is-column-drop-target'));
      target.classList.add('is-column-drop-target');
      return;
    }
    const column = event.target.closest('[data-drop-column]');
    if (!column || !root.contains(column) || !draggedCardId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('.boards-column.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
    column.classList.add('is-drop-target');
  }

  function onDragLeave(event) {
    if (draggedColumnId) {
      const target = event.target.closest('[data-drag-column]');
      if (!target || target.contains(event.relatedTarget)) return;
      target.classList.remove('is-column-drop-target');
      return;
    }
    const column = event.target.closest('[data-drop-column]');
    if (!column || column.contains(event.relatedTarget)) return;
    column.classList.remove('is-drop-target');
  }

  function onDrop(event) {
    if (!canWrite()) return onDragEnd();
    if (draggedColumnId) {
      const targetEl = event.target.closest('[data-drag-column]');
      if (!targetEl) return onDragEnd();
      event.preventDefault();
      const movingId = draggedColumnId;
      const targetId = targetEl.dataset.dragColumn;
      if (String(movingId) === String(targetId)) return onDragEnd();
      const board = activeBoard();
      const columns = sorted(board?.columns.filter(column => !column.archived));
      const movingColumn = columns.find(column => String(column.id) === String(movingId));
      const targetColumn = columns.find(column => String(column.id) === String(targetId));
      if (!board || !movingColumn || !targetColumn) return onDragEnd();
      const after = event.clientX > targetEl.getBoundingClientRect().left + targetEl.getBoundingClientRect().width / 2;
      const reordered = columns.filter(column => String(column.id) !== String(movingId));
      const targetIndex = reordered.findIndex(column => String(column.id) === String(targetId));
      const insertionIndex = Math.max(0, targetIndex + (after ? 1 : 0));
      reordered.splice(insertionIndex, 0, movingColumn);
      onDragEnd();
      saveColumnOrder(board, reordered);
      return;
    }

    const columnEl = event.target.closest('[data-drop-column]');
    if (!columnEl || !draggedCardId) return;
    event.preventDefault();
    const movingId = draggedCardId;
    const board = activeBoard();
    const targetColumn = findColumn(board, columnEl.dataset.dropColumn);
    const found = findCard(board, movingId);
    if (!board || !targetColumn || !found) return onDragEnd();
    const activeTargetCards = sorted(targetColumn.cards.filter(card => !card.archived));
    const targetCardEl = event.target.closest('[data-card-id]');
    let position;
    if (targetCardEl && String(targetCardEl.dataset.cardId) === String(movingId)) {
      onDragEnd();
      return;
    }
    if (!targetCardEl) {
      position = activeTargetCards.filter(card => String(card.id) !== String(movingId)).length;
    } else {
      const targetId = targetCardEl.dataset.cardId;
      const targetIndex = activeTargetCards.findIndex(card => String(card.id) === String(targetId));
      const after = event.clientY > targetCardEl.getBoundingClientRect().top + targetCardEl.getBoundingClientRect().height / 2;
      const cardsWithoutDragged = activeTargetCards.filter(card => String(card.id) !== String(movingId));
      const targetInRemaining = cardsWithoutDragged.findIndex(card => String(card.id) === String(targetId));
      position = targetInRemaining < 0 ? cardsWithoutDragged.length : targetInRemaining + (after ? 1 : 0);
      if (targetIndex < 0) position = cardsWithoutDragged.length;
    }
    const fromColumnId = found.column.id;
    onDragEnd();
    if (String(fromColumnId) === String(targetColumn.id)) {
      const cards = sorted(found.column.cards.filter(card => !card.archived));
      const oldIndex = cards.findIndex(card => String(card.id) === String(movingId));
      if (oldIndex === position) return;
    }
    moveCard(found.card.id, targetColumn.id, position);
  }

  function onDragEnd() {
    draggedCardId = null;
    draggedColumnId = null;
    root?.querySelectorAll('.boards-card.is-dragging').forEach(card => card.classList.remove('is-dragging'));
    root?.querySelectorAll('.boards-column.is-drop-target').forEach(column => column.classList.remove('is-drop-target'));
    root?.querySelectorAll('.boards-column.is-column-dragging').forEach(column => column.classList.remove('is-column-dragging'));
    root?.querySelectorAll('.boards-column.is-column-drop-target').forEach(column => column.classList.remove('is-column-drop-target'));
  }

  window.renderBoards = async function renderBoards(target) {
    mount(target);
    render();
    await loadBoards(true);
    return root;
  };
})();
