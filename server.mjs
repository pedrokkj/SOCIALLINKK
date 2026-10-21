import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const uploadDir = join(dataDir, 'uploads');
mkdirSync(uploadDir, { recursive: true });
const generationDir = join(dataDir, 'generations');
const openAiKeyPath = join(dataDir, 'openai-api-key');
mkdirSync(generationDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, '3a-workspace.sqlite'));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, actor_id TEXT NOT NULL DEFAULT '', changed_at TEXT NOT NULL);
INSERT OR IGNORE INTO workspace_state (id,revision,actor_id,changed_at) VALUES (1,0,'',CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS workspace_changes (revision INTEGER PRIMARY KEY,actor_id TEXT NOT NULL DEFAULT '',client_id TEXT NOT NULL DEFAULT '',changed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', permissions TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, profile_avatar TEXT NOT NULL DEFAULT '', profile_cover TEXT NOT NULL DEFAULT '', profile_color TEXT NOT NULL DEFAULT '#d8ff36');
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, segment TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '', voice TEXT NOT NULL DEFAULT '', offerings TEXT NOT NULL DEFAULT '', objectives TEXT NOT NULL DEFAULT '[]', content_pillars TEXT NOT NULL DEFAULT '[]', brand_colors TEXT NOT NULL DEFAULT '[]', posting_days TEXT NOT NULL DEFAULT '[]', posting_time TEXT NOT NULL DEFAULT '09:00', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS client_instagram_accounts (client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE, instagram_user_id TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', account_type TEXT NOT NULL DEFAULT '', access_token_encrypted TEXT NOT NULL, token_expires_at TEXT NOT NULL DEFAULT '', connected_by TEXT REFERENCES users(id) ON DELETE SET NULL, connected_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS instagram_oauth_states (state TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, return_origin TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, filename TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'reference', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE, generation_day TEXT NOT NULL DEFAULT 'segunda', posts_per_cycle INTEGER NOT NULL DEFAULT 3, publish_days TEXT NOT NULL DEFAULT '["terça","quinta","domingo"]', publish_time TEXT NOT NULL DEFAULT '09:00', briefing_instructions TEXT NOT NULL DEFAULT '', briefing_asset_ids TEXT NOT NULL DEFAULT '[]', image_instructions TEXT NOT NULL DEFAULT '', image_asset_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flow_runs (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE, run_type TEXT NOT NULL, status TEXT NOT NULL, briefing_text TEXT NOT NULL DEFAULT '', image_filename TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS clients_name_idx ON clients(name);
CREATE INDEX IF NOT EXISTS assets_client_idx ON assets(client_id);`);
for (const [column,definition] of [['stage',"TEXT NOT NULL DEFAULT ''"],['caption_text',"TEXT NOT NULL DEFAULT ''"],['scheduled_at',"TEXT NOT NULL DEFAULT ''"],['approved_at',"TEXT NOT NULL DEFAULT ''"],['parent_run_id',"TEXT NOT NULL DEFAULT ''"],['revision_note',"TEXT NOT NULL DEFAULT ''"],['version_number',"INTEGER NOT NULL DEFAULT 1"]]) {
  if (!db.prepare('PRAGMA table_info(flow_runs)').all().some(item=>item.name===column)) db.exec(`ALTER TABLE flow_runs ADD COLUMN ${column} ${definition}`);
}
if (!db.prepare('PRAGMA table_info(flow_runs)').all().some(item=>item.name==='creative_spec')) db.exec("ALTER TABLE flow_runs ADD COLUMN creative_spec TEXT NOT NULL DEFAULT '{}'");
if (!db.prepare('PRAGMA table_info(clients)').all().some(item=>item.name==='profile_asset_id')) db.exec("ALTER TABLE clients ADD COLUMN profile_asset_id TEXT NOT NULL DEFAULT ''");
for (const [column,definition] of [['auto_schedule_enabled','INTEGER NOT NULL DEFAULT 0']]) if (!db.prepare('PRAGMA table_info(clients)').all().some(item=>item.name===column)) db.exec(`ALTER TABLE clients ADD COLUMN ${column} ${definition}`);
// Preserve the legacy per-flow publication rules while moving the source of truth to the client.
db.prepare("UPDATE clients SET posting_days=(SELECT publish_days FROM flows WHERE flows.client_id=clients.id),posting_time=(SELECT publish_time FROM flows WHERE flows.client_id=clients.id) WHERE posting_days='[]' AND EXISTS (SELECT 1 FROM flows WHERE flows.client_id=clients.id)").run();
for (const [column, definition] of [['profile_avatar', "TEXT NOT NULL DEFAULT ''"], ['profile_cover', "TEXT NOT NULL DEFAULT ''"], ['profile_color', "TEXT NOT NULL DEFAULT '#d8ff36'"]]) if (!db.prepare('PRAGMA table_info(users)').all().some(item => item.name === column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
const hadRoleColor=db.prepare('PRAGMA table_info(roles)').all().some(item=>item.name==='color');if(!hadRoleColor){db.exec("ALTER TABLE roles ADD COLUMN color TEXT NOT NULL DEFAULT '#4946f5'");const rolePalette=['#27ae73','#ff6b8a','#ff9f43','#22a6b3','#bba4ff','#4946f5'];db.prepare('SELECT id FROM roles WHERE system=0 ORDER BY created_at,id').all().forEach((role,index)=>db.prepare('UPDATE roles SET color=? WHERE id=?').run(rolePalette[index%rolePalette.length],role.id));db.prepare("UPDATE roles SET color='#d8ff36' WHERE system=1").run();}
db.exec(`CREATE TABLE IF NOT EXISTS manual_posts (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, image_filename TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, caption_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending_approval', rejection_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, approved_at TEXT NOT NULL DEFAULT '')`);
if (!db.prepare('PRAGMA table_info(manual_posts)').all().some(item=>item.name==='scheduled_at')) db.exec("ALTER TABLE manual_posts ADD COLUMN scheduled_at TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#d8ff36',
  workflow_category TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  due_date TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS boards_archive_idx ON boards(archived, updated_at);
CREATE INDEX IF NOT EXISTS board_columns_order_idx ON board_columns(board_id, archived, position);
CREATE INDEX IF NOT EXISTS board_cards_order_idx ON board_cards(column_id, archived, position);
CREATE INDEX IF NOT EXISTS board_cards_client_idx ON board_cards(client_id);
CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(board_id,user_id)
);
CREATE TABLE IF NOT EXISTS board_labels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4946f5',
  created_at TEXT NOT NULL,
  UNIQUE(board_id,name)
);
CREATE TABLE IF NOT EXISTS board_card_labels (
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES board_labels(id) ON DELETE CASCADE,
  PRIMARY KEY(card_id,label_id)
);
CREATE TABLE IF NOT EXISTS board_card_assignees (
  board_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(card_id,user_id),
  FOREIGN KEY(board_id,user_id) REFERENCES board_members(board_id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS board_card_assignees_user_idx ON board_card_assignees(user_id);
CREATE TABLE IF NOT EXISTS board_card_checklist (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE, title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_card_comments (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_card_attachments (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  filename TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_card_activity (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_card_checklist_idx ON board_card_checklist(card_id,position);
CREATE INDEX IF NOT EXISTS board_card_comments_idx ON board_card_comments(card_id,created_at);
CREATE INDEX IF NOT EXISTS board_card_attachments_idx ON board_card_attachments(card_id,created_at);
CREATE INDEX IF NOT EXISTS board_card_activity_idx ON board_card_activity(card_id,created_at);`);
db.exec(`INSERT OR IGNORE INTO board_members (board_id,user_id,added_by,created_at)
  SELECT id,created_by,created_by,created_at FROM boards WHERE created_by IS NOT NULL`);

if (!db.prepare('PRAGMA table_info(board_columns)').all().some(item => item.name === 'workflow_category')) {
  db.exec("ALTER TABLE board_columns ADD COLUMN workflow_category TEXT NOT NULL DEFAULT ''");
}
for (const [column,definition] of [['scheduled_at',"TEXT NOT NULL DEFAULT ''"],['schedule_mode',"TEXT NOT NULL DEFAULT ''"]]) {
  if (!db.prepare('PRAGMA table_info(board_cards)').all().some(item=>item.name===column)) db.exec(`ALTER TABLE board_cards ADD COLUMN ${column} ${definition}`);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS board_columns_workflow_category_unique ON board_columns(board_id,workflow_category) WHERE archived=0 AND workflow_category<>''");
const BOARD_WORKFLOW_CATEGORIES = Object.freeze({
  intake: 'Produzir / solicitação',
  production: 'Em produção',
  internal_review: 'Revisão interna',
  client_approval: 'Aguardando aprovação',
  changes: 'Alterações',
  schedule: 'Programar',
  completed: 'Concluído'
});
db.prepare("UPDATE board_columns SET workflow_category='' WHERE workflow_category IN ('client_approved','ready_to_schedule','scheduled','published')").run();

const PERMISSION_CATALOG = {
  'clients.view':'Ver clientes','clients.create':'Criar clientes','clients.edit':'Editar clientes','clients.delete':'Excluir clientes','clients.references':'Adicionar referências',
  'users.view':'Ver usuários','users.create':'Criar usuários','users.edit':'Editar usuários','users.delete':'Excluir usuários','roles.view':'Ver cargos','roles.create':'Criar cargos','roles.edit':'Editar cargos','roles.delete':'Excluir cargos',
  'flows.view':'Ver fluxos','flows.create':'Criar fluxos','flows.edit':'Editar fluxos','flows.configure':'Configurar fluxos','flows.run':'Executar fluxos','flows.approve':'Aprovar conteúdo','flows.reject':'Reprovar conteúdo',
  'boards.view':'Ver quadros','boards.create':'Criar quadros','boards.edit':'Editar quadros','boards.delete':'Excluir quadros','boards.cards.create':'Criar cartões','boards.cards.edit':'Editar cartões','boards.cards.archive':'Arquivar cartões','boards.columns.manage':'Gerenciar listas','boards.members.manage':'Gerenciar membros','boards.labels.manage':'Gerenciar etiquetas','boards.comments.create':'Comentar em cartões',
  'tasks.view':'Ver tarefas','tasks.create':'Criar tarefas','tasks.edit':'Editar tarefas','tasks.delete':'Excluir tarefas','calendar.view':'Ver calendário','calendar.create':'Criar eventos','calendar.edit':'Editar eventos','calendar.delete':'Excluir eventos',
  'library.view':'Ver biblioteca','library.upload':'Adicionar arquivos','library.delete':'Excluir arquivos','reports.view':'Ver relatórios','reports.export':'Exportar relatórios','settings.view':'Ver configurações','settings.manage':'Alterar configurações','profile.edit':'Editar o próprio perfil'
};
const LEGACY_PERMISSION_MAP={'clients.read':['clients.view'],'clients.write':['clients.create','clients.edit','clients.delete','clients.references'],'assets.write':['clients.references'],'users.manage':['users.view','users.create','users.edit','users.delete'],'roles.manage':['roles.view','roles.create','roles.edit','roles.delete'],'flows.read':['flows.view'],'flows.write':['flows.create','flows.edit','flows.configure','flows.run','flows.approve','flows.reject'],'boards.read':['boards.view'],'boards.write':['boards.create','boards.edit','boards.delete','boards.cards.create','boards.cards.edit','boards.cards.archive','boards.columns.manage','boards.members.manage','boards.labels.manage','boards.comments.create']};
const PERMISSIONS=Object.keys(PERMISSION_CATALOG);
function safePermissionList(value){return Array.isArray(value)?[...new Set(value.filter(permission=>typeof permission==='string'&&PERMISSIONS.includes(permission)))]:[];}
function permissionsForStorage(value){const source=Array.isArray(value)?value:[];return safePermissionList(source.flatMap(permission=>LEGACY_PERMISSION_MAP[permission]||[permission]));}
const weekdays = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
const now = () => new Date().toISOString();
const id = () => randomBytes(16).toString('hex');
function createSession(userId){const token=randomBytes(32).toString('base64url'),stamp=now();db.prepare('INSERT INTO sessions (token,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(token,userId,new Date(Date.now()+30*86400000).toISOString(),stamp);return token;}
const instagramKeyPath=join(dataDir,'instagram-encryption-key');
function instagramEncryptionKey(){if(process.env.SOCIALINK_DATA_KEY){const key=Buffer.from(process.env.SOCIALINK_DATA_KEY,'hex');if(key.length!==32)throw new Error('SOCIALINK_DATA_KEY precisa ter 64 caracteres hexadecimais.');return key;}if(!existsSync(instagramKeyPath))writeFileSync(instagramKeyPath,randomBytes(32),{flag:'wx',mode:0o600});const key=readFileSync(instagramKeyPath);if(key.length!==32)throw new Error('Chave local de criptografia inválida.');return key;}
function encryptInstagramSecret(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',instagramEncryptionKey(),iv),encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;}
function decryptInstagramSecret(value){const [iv,tag,body]=String(value||'').split('.');if(!iv||!tag||!body)throw new Error('Credencial criptografada inválida.');const decipher=createDecipheriv('aes-256-gcm',instagramEncryptionKey(),Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8');}
function instagramAppConfig(){const row=db.prepare("SELECT value FROM settings WHERE key='instagram_app_config'").get();let stored=null;try{stored=row?JSON.parse(decryptInstagramSecret(row.value)):null;}catch{}return {appId:process.env.META_INSTAGRAM_APP_ID||stored?.appId||'',appSecret:process.env.META_INSTAGRAM_APP_SECRET||stored?.appSecret||''};}
function instagramRedirectUri(req){if(process.env.META_INSTAGRAM_REDIRECT_URI)return process.env.META_INSTAGRAM_REDIRECT_URI;const host=req.headers.host||'127.0.0.1:3002';const protocol=(req.headers['x-forwarded-proto']||'http').toString().split(',')[0].trim();return `${protocol}://${host}/api/integrations/instagram/callback`;}
function trustedReturnOrigin(req){const origin=req.headers.origin||'';const allowed=new Set(['http://127.0.0.1:3001','http://localhost:3001',process.env.SOCIALINK_WEB_ORIGIN].filter(Boolean));return allowed.has(origin)?origin:(process.env.SOCIALINK_WEB_ORIGIN||'http://127.0.0.1:3001');}
const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const assetCategories = ['logo', 'profile', 'brand-guide', 'published-post', 'reference', 'other'];
const defaultRoleId = 'role-admin';
if (!db.prepare('SELECT id FROM roles WHERE id=?').get(defaultRoleId)) {
  db.prepare('INSERT INTO roles (id,name,description,permissions,system,created_at) VALUES (?,?,?,?,1,?)')
    .run(defaultRoleId, 'Administrador', 'Acesso total à plataforma.', JSON.stringify(PERMISSIONS), now());
}
const adminPermissions = JSON.parse(db.prepare('SELECT permissions FROM roles WHERE id=?').get(defaultRoleId).permissions);
const mergedAdminPermissions = permissionsForStorage([...adminPermissions, ...PERMISSIONS]);
if (mergedAdminPermissions.length !== adminPermissions.length) db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify(mergedAdminPermissions), defaultRoleId);
for(const role of db.prepare('SELECT id,permissions FROM roles').all()){const original=JSON.parse(role.permissions),granular=safePermissionList(original),migrated=granular.length?granular:safePermissionList(original.flatMap(permission=>LEGACY_PERMISSION_MAP[permission]||[permission]));if(JSON.stringify(original)!==JSON.stringify(migrated))db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify(migrated),role.id);}

function send(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', ...headers });
  res.end(payload);
}
function fail(res, status, message) { send(res, status, { error: message }); }
function openAiKey() { return (process.env.OPENAI_API_KEY || (existsSync(openAiKeyPath) ? readFileSync(openAiKeyPath, 'utf8').trim() : '')).trim(); }
function openAiConfigured() { return Boolean(openAiKey()); }
function flowRunView(row) { let creativeSpec={};try{creativeSpec=JSON.parse(row.creative_spec||'{}');}catch{} return { id: row.id, flowId: row.flow_id, clientId:row.client_id||'', type: row.run_type, status: row.status, stage: row.stage||'', briefingText: row.briefing_text, caption: row.caption_text||'', creativeSpec, imageUrl: row.image_filename ? `/api/flow-runs/${row.id}/image` : '', scheduledAt:row.scheduled_at||'', approvedAt:row.approved_at||'', parentRunId:row.parent_run_id||'',revisionNote:row.revision_note||'',versionNumber:row.version_number||1,error: row.error, createdAt: row.created_at, clientName:row.client_name||'' }; }
async function openAiRequest(endpoint, options) {
  const response = await fetch(`https://api.openai.com/v1/${endpoint}`, { ...options, headers: { authorization: `Bearer ${openAiKey()}`, ...(options.headers || {}) }, signal: AbortSignal.timeout(180000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `A API OpenAI respondeu ${response.status}.`);
  return data;
}
async function generateBriefing(flow, revisionNote = '') {
  const client = flow.client;
  const refs = client.assets.filter(asset => flow.briefingAssetIds.includes(asset.id));
  const layoutVariants=['asymmetric_editorial','centered_poster','focal_element','photo_integrated','layered_planes','diagonal_composition','minimal_typography','conceptual_graphic'];
  const previousLayouts=db.prepare("SELECT creative_spec FROM flow_runs WHERE flow_id=? AND creative_spec<>'{}' ORDER BY created_at DESC LIMIT 4").all(flow.id).map(row=>{try{return JSON.parse(row.creative_spec).layout_variant||'';}catch{return '';}}).filter(layout=>layoutVariants.includes(layout));
  const input = [{ type: 'input_text', text: `Você é estrategista de conteúdo e diretora de arte de uma agência. Crie uma pauta fiel ao negócio e um plano de arte executável. Não invente fatos, números, serviços, resultados ou alegações jurídicas. Posts de referência NÃO são anexados ao gerador de texto. Use apenas as instruções escritas do cliente como regras abstratas de identidade visual: cores, tipografia, hierarquia, composição, formas e nível de texto. Essas instruções nunca são fontes de conteúdo. Não reutilize títulos, frases, argumentos ou temas das referências conhecidos pelo cliente. Não escolha um assunto só porque ele aparece em uma referência. A pauta deve ser original, ligada ao perfil do cliente e aos seus pilares editoriais; prefira uma abordagem inédita dentro do tema, em vez de repetir uma pergunta ou chamada já publicada. Retorne português brasileiro, seguindo rigorosamente o JSON Schema configurado.
PADRÃO GERAL DA AGÊNCIA — aplicar a todos os clientes e refinar com as regras de identidade cadastradas:
1) As quatro imagens aprovadas são exemplos de uma identidade, não quatro templates. Extraia o sistema visual comum — paleta creme/off-white, grafite e dourado fosco; serifada editorial em manchetes; sans-serif auxiliar; escalas tipográficas expressivas; diagonais, curvas, contornos finos, gradientes tonais discretos, fotografia/editorial e planos sobrepostos. Não associe cada referência a uma montagem fixa. Escolha a composição a partir da mensagem: asymmetric_editorial, centered_poster, focal_element, photo_integrated, layered_planes, diagonal_composition, minimal_typography ou conceptual_graphic. Varie de verdade alinhamento, escala, posição do logo, equilíbrio entre foto e tipo, tratamento da imagem, distribuição de cores, função e posição das formas. Nunca repita por conveniência a mesma forma ou a mesma disposição. Os gradientes devem ser sutis e integrados aos planos; dourado fosco é acento, sem brilho metálico. Não use moldura retangular arredondada genérica, cartões ou divisão vertical reta. Foto não é obrigatória e elemento não é decoração: cada um deve esclarecer a mensagem.
2) Use uma manchete curta e, se realmente acrescentar informação, uma linha de apoio. Mantenha ambas em zona de texto limpa, com contraste e respiro. O apoio deve ficar imediatamente associado à manchete por escala, proximidade e no máximo um recurso editorial discreto; nunca sobre a fotografia, sobre o logo ou solto no rodapé. Reserve espaço suficiente e não permita colisão entre texto, imagem, grafismos ou marca. Não coloque CTA, hashtags, nome da empresa, nome do segmento, rodapé repetindo a marca ou texto decorativo na arte. O logo original será aplicado pela plataforma.
3) Siga a família tipográfica e a hierarquia visual descritas nas instruções escritas do cliente. Descreva a tipografia de forma executável e use fontes visualmente próximas quando a fonte exata não estiver disponível.
4) Escolha visual_mode conforme a pauta: photograph para fotografia editorial, editorial_illustration para ilustração, abstract para formas e linhas da marca, typography_only para arte sem foto nem ilustração. Prefira um objeto, documento, detalhe ou metáfora diretamente ligado à pauta. Não use pessoas por padrão; só as inclua quando o assunto exigir e a identidade permitir. Se uma imagem literal não ajudar, use formas, linhas, molduras e cores da marca, sem objetos aleatórios. A imagem deve parecer intencionalmente diagramada: evite corte reto, borda abrupta, objeto cortado sem propósito e foto simplesmente colada ao lado do texto.
5) O destaque colorido atrás de palavras é opcional e seletivo: marque no máximo um trecho curto da manchete, somente quando as referências justificarem.
Briefing: descreva objetivo, público, formato, mensagem, motivo editorial, montagem escolhida e como aplicar as regras de identidade sem copiar qualquer peça de referência.
Texto exato da arte: manchete de até 65 caracteres; apoio de até 100 caracteres ou vazio. Indique alinhamento (left, center ou right), estilo de fonte (editorial_serif, classic_serif, clean_sans ou geometric_sans), tratamento do subtítulo (editorial_rule, accent_label, italic_serif, accent_block ou compact_card), se a manchete é toda maiúscula e o trecho curto a destacar com caixa de cor (ou vazio). O CTA da arte deve ser sempre vazio. A arte terá somente manchete, apoio opcional e logo original.
Montagem: escolha layout_variant entre ${layoutVariants.join(', ')}. Use as referências para identidade, não para copiar composições. Escolha visual_mode entre photograph, editorial_illustration, abstract e typography_only conforme o conceito. Montagens recentes: ${previousLayouts.join(', ')||'nenhuma registrada'}; varie quando fizer sentido para a mensagem.
Direção visual: indique cena/sujeito diretamente pertinente, elementos visuais necessários, área reservada ao texto, tratamento das bordas e posição relativa de cada elemento. Não peça palavras, letras, números ou logos para a imagem gerada; a plataforma compõe o texto e aplica o logo original depois.
Legenda — padrão geral: gancho direto na abertura; 2 ou 3 parágrafos curtos e didáticos; CTA conversacional no último parágrafo, sem inventar WhatsApp ou canal de contato. Termine com exatamente 5 hashtags relevantes, preferencialmente minúsculas, separadas por três linhas contendo apenas um ponto. Use emojis com moderação e preserve o tom do cliente. A legenda complementa a arte, sem repetir tudo que já está nela.

CLIENTE: ${client.name}
SEGMENTO: ${client.segment}
SOBRE: ${client.description}
PÚBLICO: ${client.audience}
TOM DE VOZ: ${client.voice}
SERVIÇOS: ${client.offerings}
OBJETIVOS: ${client.objectives.join(', ')}
PILARES: ${client.contentPillars.join(', ')}
CORES: ${client.brandColors.join(', ')}
INSTRUÇÕES: ${flow.briefingInstructions}
AJUSTES PEDIDOS PELA EQUIPE: ${revisionNote||'Nenhum'}
REFERÊNCIAS VISUAIS: ${refs.length ? `${refs.length} arquivo(s) selecionado(s); seus nomes e pixels são omitidos do gerador de texto.` : 'Nenhuma'}` }];
  // Never pass reference artwork into the copywriting model: OCR-visible copy
  // caused it to repeat client headlines. Identity rules are supplied as text.
  const data = await openAiRequest('responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini', input: [{ role: 'user', content: input }], max_output_tokens: 1800, text: { format: { type: 'json_schema', name: '3a_social_content_brief', strict: true, schema: { type: 'object', additionalProperties: false, properties: { briefing: { type: 'string' }, caption: { type: 'string' }, layout_variant: { type: 'string', enum: layoutVariants }, visual_mode: { type: 'string', enum: ['photograph','editorial_illustration','abstract','typography_only'] }, art_text: { type: 'object', additionalProperties: false, properties: { headline: { type: 'string' }, supporting_text: { type: 'string' }, cta: { type: 'string' }, alignment: { type: 'string', enum: ['left','center','right'] }, uppercase: { type: 'boolean' }, highlight_phrase: { type: 'string' }, font_style: { type: 'string', enum: ['editorial_serif','classic_serif','clean_sans','geometric_sans'] }, support_style: { type: 'string', enum: ['editorial_rule','accent_label','italic_serif','accent_block','compact_card'] } }, required: ['headline','supporting_text','cta','alignment','uppercase','highlight_phrase','font_style','support_style'] }, visual_concept: { type: 'string' }, visual_direction: { type: 'string' }, visual_elements: { type: 'array', items: { type: 'string' } } }, required: ['briefing','caption','layout_variant','visual_mode','art_text','visual_concept','visual_direction','visual_elements'] } } } }) });
  const text = data.output_text || data.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n') || '';
  if (!text) throw new Error('A API respondeu sem texto de briefing.');
  let spec;try{spec=JSON.parse(text);}catch{throw new Error('O briefing retornou fora do formato estruturado esperado. Gere novamente.');}
  const fontStyles=['editorial_serif','classic_serif','clean_sans','geometric_sans'];
  spec.layout_variant=layoutVariants.includes(spec.layout_variant)?spec.layout_variant:'asymmetric_editorial';
  spec.visual_mode=['photograph','editorial_illustration','abstract','typography_only'].includes(spec.visual_mode)?spec.visual_mode:'photograph';
  spec.art_text={headline:safeText(spec.art_text?.headline,65),supporting_text:safeText(spec.art_text?.supporting_text,100),cta:'',alignment:['center','right'].includes(spec.art_text?.alignment)?spec.art_text.alignment:'left',uppercase:Boolean(spec.art_text?.uppercase),highlight_phrase:safeText(spec.art_text?.highlight_phrase,40),font_style:fontStyles.includes(spec.art_text?.font_style)?spec.art_text.font_style:'editorial_serif',support_style:['editorial_rule','accent_label','italic_serif','accent_block','compact_card'].includes(spec.art_text?.support_style)?spec.art_text.support_style:'editorial_rule'};
  const normalizeCopy=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  const accertReferenceHeadlines=['quando uma pericia contabil e necessaria','nem toda questao pode ser esclarecida apenas pela analise juridica','desapropriacao nao gera lucro cessante automatico','foi designada pericia no seu processo e agora','dia do contador','onde muitos veem numeros os contadores enxergam resultados','analise precisao e conhecimento que transformam numeros em decisoes'];
  if(/accert/i.test(client.name)&&accertReferenceHeadlines.some(phrase=>normalizeCopy(spec.art_text.headline).includes(phrase)||normalizeCopy(spec.caption).includes(phrase))){
    if(!revisionNote.includes('[RETRY ANTI-COPIA]'))return generateBriefing(flow,`${revisionNote}\n[RETRY ANTI-COPIA] A resposta anterior repetiu texto de uma publicação existente. Descarte a pauta inteira e crie outra abordagem editorial, sem reutilizar pergunta, chamada ou frase das referências.`);
    throw new Error('O briefing tentou repetir texto de uma referência da Accert duas vezes. Nenhuma arte foi criada; tente novamente.');
  }
  spec.visual_elements=safeList(spec.visual_elements);
  const layoutLabels={asymmetric_editorial:'composição editorial assimétrica',centered_poster:'cartaz editorial centralizado',focal_element:'elemento conceitual protagonista',photo_integrated:'fotografia integrada à composição',layered_planes:'planos editoriais sobrepostos',diagonal_composition:'composição diagonal',minimal_typography:'tipografia minimalista',conceptual_graphic:'composição gráfica conceitual'};const visualLabels={photograph:'fotografia editorial',editorial_illustration:'ilustração editorial',abstract:'formas e linhas abstratas',typography_only:'tipografia e formas da marca'};const supportLabels={editorial_rule:'filete editorial',accent_label:'marcador lateral',italic_serif:'serifada em itálico',accent_block:'bloco de cor suave',compact_card:'cartão discreto'};
  const humanBrief=`${safeText(spec.briefing,6000)}\n\nMONTAGEM\n${layoutLabels[spec.layout_variant]} · ${visualLabels[spec.visual_mode]}\n\nTEXTO EXATO NA ARTE\nManchete: ${spec.art_text.headline||'—'}\nApoio: ${spec.art_text.supporting_text||'—'}\nTratamento do apoio: ${supportLabels[spec.art_text.support_style]}\nAlinhamento: ${spec.art_text.alignment}\nCTA: ${spec.art_text.cta||'—'}\n\nDIREÇÃO VISUAL\n${safeText(spec.visual_concept,1000)}\n${safeText(spec.visual_direction,1500)}\nElementos: ${spec.visual_elements.join(', ')||'—'}`;
  return {text:humanBrief,caption:safeText(spec.caption,3000),spec};
}
function xml(value=''){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
function imageCreativeSpec(flow){return {briefing:'Arte de teste visual isolado.',caption:'',layout_variant:'asymmetric_editorial',visual_mode:'photograph',art_text:{headline:'',supporting_text:'',cta:'',alignment:'left',font_style:'editorial_serif',support_style:'editorial_rule'},visual_concept:flow.imageInstructions||'Uma composição editorial relevante para a marca.',visual_direction:flow.imageInstructions||'Seguir a identidade visual do cliente.',visual_elements:[]};}
async function generateImage(flow, creativeSpec = imageCreativeSpec(flow)) {
  const selected=flow.client.assets.filter(asset=>flow.imageAssetIds.includes(asset.id)&&asset.mimeType.startsWith('image/')).slice(0,16);
  const logos=selected.filter(asset=>asset.category==='logo');const visualRefs=selected.filter(asset=>asset.category!=='logo');
  const orderedRefs=[...logos,...visualRefs];
  const referenceGuide=orderedRefs.map((asset,index)=>`Imagem ${index+1}: ${asset.category==='logo'?'arquivo original do logotipo — usar apenas como ativo de marca; preservar proporção e aparência':asset.category==='published-post'?'post aprovado — observar somente linguagem visual, paleta, tipografia, acabamento e variedade de composição; não copiar texto, assunto, objetos ou diagramação':`referência visual — usar somente os aspectos pertinentes ao conceito, sem copiar conteúdo literal`}`).join('\n');
  const recentLayouts=db.prepare("SELECT creative_spec FROM flow_runs WHERE flow_id=? AND creative_spec<>'{}' ORDER BY created_at DESC LIMIT 4").all(flow.id).map(row=>{try{return JSON.parse(row.creative_spec).layout_variant||'';}catch{return '';}}).filter(layout=>['asymmetric_editorial','centered_poster','focal_element','photo_integrated','layered_planes','diagonal_composition','minimal_typography','conceptual_graphic'].includes(layout));
  const exactHeadline=safeText(creativeSpec?.art_text?.headline,65);const exactSupport=safeText(creativeSpec?.art_text?.supporting_text,100);
  const prompt=`Create the complete, finished original 4:5 social-media artwork as one intentionally art-directed image. Think like a senior editorial art director: understand the message first, form one specific visual concept, choose only the elements that explain it, then compose the whole piece. Do not build a generic template or arrange components mechanically.

REFERENCE ROLE — CRITICAL
The supplied images are visual references, not source content. Study the set as a whole to learn the brand's visual grammar: palette, serif/sans-serif contrast, spacing, image treatment, gradients, geometric shapes, fine contours, depth, lighting, and professional finish. Combine and vary those principles. Never reproduce any reference's headline, caption, subject, document, object, exact arrangement, crop, or signature motif placement. Do not take a reference object just because it appears in a post; choose imagery exclusively from the new post's message. The supplied original logo is a protected brand asset: include it once, with its original appearance and proportions, without redrawing or embellishing it.
${referenceGuide||'No visual references were selected. Follow the brand profile and written directions below.'}

CREATIVE DECISIONS
The briefing has selected a broad composition family: ${creativeSpec?.layout_variant||'choose the most appropriate family from the supplied references'}. Treat it as a direction, not a fixed grid. Vary placement, scale, crop, color balance, geometry, and relationship between type and image according to this specific message. Avoid the last compositions (${recentLayouts.join(', ')||'none recorded'}) when another appropriate option exists. Do not repeat the same shape in the same position by default.
Use photography, illustration, a conceptual graphic, a document/object, or typography alone only when that choice helps communicate the topic. If a photograph is used, integrate it with deliberate art direction: a shaped or layered crop, controlled tonal/gradient transition, believable depth and lighting, or a considered overlap. Avoid a crude straight split, pasted-on image, arbitrary wavy blob, generic rounded frame, floating stock objects, and ornamental shapes without purpose. Keep negative space intentional. Use gold as a measured accent; gradients should be subtle, tonal, and grounded in the reference finish, never shiny or metallic.

CLIENT: ${flow.client.name}
BUSINESS: ${flow.client.segment}
BRAND COLORS: ${flow.client.brandColors.join(', ')}
BRAND DIRECTIONS: ${flow.imageInstructions||'Follow the written client identity profile.'}
BRIEFING: ${safeText(creativeSpec?.briefing,5000)}
VISUAL CONCEPT: ${safeText(creativeSpec?.visual_concept,1000)}
VISUAL DIRECTION: ${safeText(creativeSpec?.visual_direction,1800)}
RELEVANT ELEMENTS: ${(creativeSpec?.visual_elements||[]).join('; ')||'Select only elements directly relevant to the concept.'}

TEXT ACCURACY — render only these exact Portuguese strings, with accents and punctuation unchanged:
Headline: ${exactHeadline||'(omit if empty)'}
Supporting line: ${exactSupport||'(omit if empty)'}
Do not add any other words, numbers, fake document text, date, CTA, company name, hashtags, watermark, or decorative microcopy. Keep all text legible and clearly separated from the focal image. The supporting line must feel intentionally connected to the headline, not stranded. Place the original logo from its provided asset in a natural, quiet brand-signature area, without forcing a fixed corner.

Final review before rendering: the image expresses this topic rather than one of the reference topics; the composition feels newly designed, not like a template; the reference images informed identity but were not copied; text is exact; photo/graphic and typography are integrated; no element is misplaced, cramped, or repeated mechanically.`;
  const form=new FormData();form.append('model','gpt-image-2.5-sunburst');form.append('prompt',prompt);form.append('size','1024x1280');form.append('quality','high');form.append('output_format','png');
  for(const asset of orderedRefs){const row=db.prepare('SELECT filename FROM assets WHERE id=? AND client_id=?').get(asset.id,flow.clientId);if(!row)continue;const bytes=readFileSync(join(uploadDir,row.filename));if(bytes.length>20*1024*1024)continue;form.append('image[]',new Blob([bytes],{type:asset.mimeType}),asset.originalName);}
  const data=orderedRefs.length?await openAiRequest('images/edits',{method:'POST',body:form}):await openAiRequest('images/generations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-image-2.5-sunburst',prompt,size:'1024x1280',quality:'high',output_format:'png'})});const encoded=data.data?.[0]?.b64_json||'';
  if(!encoded)throw new Error('A API de imagens respondeu sem arquivo.');
  const filename=`${id()}.png`;writeFileSync(join(generationDir,filename),Buffer.from(encoded,'base64'),{flag:'wx'});
  return filename;
}
function readBody(req, max = 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > max) { reject(Object.assign(new Error('Arquivo ou requisição excede o limite permitido.'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function jsonBody(req) {
  const bytes = await readBody(req);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}
function safeText(value, max = 4000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function safeList(value, choices = null) {
  const list = Array.isArray(value) ? value.map(v => safeText(v, 80)).filter(Boolean).slice(0, 30) : [];
  return choices ? list.filter(v => choices.includes(v)) : list;
}
function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function passwordMatches(password, encoded) {
  const [salt, hex] = String(encoded).split(':'); if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex'); const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function userView(user) {
  const role = db.prepare('SELECT id,name,color,permissions FROM roles WHERE id=?').get(user.role_id);
  const permissions=role?JSON.parse(role.permissions):[];for(const [legacy,current] of Object.entries(LEGACY_PERMISSION_MAP))if(current.every(permission=>permissions.includes(permission)))permissions.push(legacy);
  return { id:user.id,name:user.name,email:user.email,active:Boolean(user.active),avatar:user.profile_avatar||'',cover:user.profile_cover||'',color:user.profile_color||'#d8ff36',role:role?{id:role.id,name:role.name,color:role.color||'#4946f5',permissions}:null,createdAt:user.created_at };
}
function sessionFor(req) {
  const authHeader=req.headers.authorization||'';const bearer=authHeader.startsWith('Bearer ')?authHeader.slice(7).trim():null;
  const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('3a_session='))?.slice('3a_session='.length);
  let query=null;try{query=new URL(req.url,'http://localhost').searchParams.get('token');}catch{}
  const token=bearer||cookie||query;if(!token)return null;
  const session=db.prepare('SELECT user_id,expires_at FROM sessions WHERE token=?').get(token);if(!session)return null;
  if(session.expires_at<=now()){db.prepare('DELETE FROM sessions WHERE token=?').run(token);return null;}
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user_id);
  return user || null;
}
function requirePermission(req, res, permission) {
  const user = sessionFor(req);
  if (!user) { fail(res, 401, 'Entre na plataforma para continuar.'); return null; }
  const role = db.prepare('SELECT permissions FROM roles WHERE id=?').get(user.role_id);
  const granted=role?JSON.parse(role.permissions):[];const pathname=new URL(req.url,'http://localhost').pathname,method=req.method;
  let requested=(LEGACY_PERMISSION_MAP[permission]||[permission])[0];
  if(permission==='clients.write')requested=method==='POST'&&pathname==='/api/clients'?'clients.create':method==='DELETE'?'clients.delete':'clients.edit';
  if(permission==='assets.write'||pathname.match(/^\/api\/clients\/[a-f0-9]+\/assets$/))requested='clients.references';
  if(permission==='flows.write')requested=/\/approve$/.test(pathname)?'flows.approve':/\/reject$/.test(pathname)?'flows.reject':/\/test$/.test(pathname)?'flows.run':pathname==='/api/flows'&&method==='POST'?'flows.create':method==='PUT'?'flows.configure':'flows.edit';
  if(permission==='boards.write')requested=pathname==='/api/boards'&&method==='POST'?'boards.create':/^\/api\/boards\/[a-f0-9]+\/columns/.test(pathname)?'boards.columns.manage':/^\/api\/boards\/[a-f0-9]+\/labels/.test(pathname)?'boards.labels.manage':/^\/api\/boards\/[a-f0-9]+\/members/.test(pathname)?'boards.members.manage':/\/cards\/[^/]+\/(comments|checklist|attachments)/.test(pathname)?'boards.comments.create':/^\/api\/boards\/[a-f0-9]+\/cards$/.test(pathname)&&method==='POST'?'boards.cards.create':/\/cards\/[a-f0-9]+$/.test(pathname)?'boards.cards.edit':'boards.edit';
  const legacyKeys=Object.entries(LEGACY_PERMISSION_MAP).filter(([,items])=>items.includes(requested)).map(([legacy])=>legacy);const allowed=(permission in LEGACY_PERMISSION_MAP?granted.includes(requested):granted.includes(permission))||granted.includes(permission)||legacyKeys.some(legacy=>granted.includes(legacy));
  if (!role || !allowed) { fail(res, 403, 'Seu cargo não tem permissão para esta ação.'); return null; }
  return user;
}
function hasPermissionForUser(user, permission) {
  const role = user && db.prepare('SELECT permissions FROM roles WHERE id=?').get(user.role_id);
  const granted=role?JSON.parse(role.permissions):[];return Boolean(role&&(granted.includes(permission)||granted.includes(LEGACY_PERMISSION_MAP[permission]||'')||(LEGACY_PERMISSION_MAP[permission]||[]).some(item=>granted.includes(item))));
}
function requireBoardWrite(req, res) {
  const user = requirePermission(req, res, 'boards.read');
  return user ? requirePermission(req, res, 'boards.write') : null;
}
function clientView(row) {
  const instagram=db.prepare('SELECT instagram_user_id AS userId,username,account_type AS accountType,token_expires_at AS tokenExpiresAt,connected_at AS connectedAt FROM client_instagram_accounts WHERE client_id=?').get(row.id);
  return { id: row.id, name: row.name, segment: row.segment, description: row.description, audience: row.audience, voice: row.voice, offerings: row.offerings,
    objectives: JSON.parse(row.objectives), contentPillars: JSON.parse(row.content_pillars), brandColors: JSON.parse(row.brand_colors), postingDays: JSON.parse(row.posting_days), postingTime: row.posting_time, autoScheduleEnabled:Boolean(row.auto_schedule_enabled),
    profileAssetId: row.profile_asset_id||'', instagram:instagram?{connected:true,...instagram}:{connected:false}, createdAt: row.created_at, updatedAt: row.updated_at, assets: db.prepare('SELECT id,original_name AS originalName,mime_type AS mimeType,size,category,created_at AS createdAt FROM assets WHERE client_id=? ORDER BY created_at DESC').all(row.id) };
}
function flowView(row) {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(row.client_id);
  return { id: row.id, clientId: row.client_id, generationDay: row.generation_day, postsPerCycle: row.posts_per_cycle,
    publishDays: client?JSON.parse(client.posting_days):[], publishTime: client?.posting_time||'09:00', briefingInstructions: row.briefing_instructions,
    briefingAssetIds: JSON.parse(row.briefing_asset_ids), imageInstructions: row.image_instructions, imageAssetIds: JSON.parse(row.image_asset_ids),
    createdAt: row.created_at, updatedAt: row.updated_at, client: client ? clientView(client) : null };
}
function boardCardView(row, canReadClients) {
  const labels = db.prepare(`SELECT l.id,l.name,l.color FROM board_card_labels cl
    JOIN board_labels l ON l.id=cl.label_id WHERE cl.card_id=? ORDER BY l.name COLLATE NOCASE`).all(row.id);
  const assignees = db.prepare(`SELECT u.id,u.name,u.profile_avatar AS avatar,u.profile_cover AS cover,u.profile_color AS color,r.name AS role,r.color AS roleColor FROM board_card_assignees ca
    JOIN users u ON u.id=ca.user_id JOIN roles r ON r.id=u.role_id
    WHERE ca.card_id=? AND u.active=1 ORDER BY u.name COLLATE NOCASE`).all(row.id);
  const checklist = db.prepare(`SELECT id,title,completed,position,created_at AS createdAt,updated_at AS updatedAt FROM board_card_checklist WHERE card_id=? ORDER BY position,created_at`).all(row.id).map(item=>({...item,completed:Boolean(item.completed)}));
  const comments = db.prepare(`SELECT c.id,c.body,c.created_at AS createdAt,u.id AS userId,COALESCE(u.name,'Pessoa removida') AS userName,u.profile_avatar AS avatar,u.profile_color AS color,r.name AS role,r.color AS roleColor FROM board_card_comments c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN roles r ON r.id=u.role_id WHERE c.card_id=? ORDER BY c.created_at DESC`).all(row.id);
  const attachments = db.prepare(`SELECT a.id,a.url,a.original_name AS originalName,a.mime_type AS mimeType,a.size,a.created_at AS createdAt,COALESCE(u.name,'Pessoa removida') AS userName FROM board_card_attachments a LEFT JOIN users u ON u.id=a.created_by WHERE a.card_id=? ORDER BY a.created_at`).all(row.id).map(item=>({...item,href:item.url||`/api/board-attachments/${item.id}`}));
  const activity = db.prepare(`SELECT a.id,a.action,a.detail,a.created_at AS createdAt,COALESCE(u.name,'Pessoa removida') AS userName FROM board_card_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.card_id=? ORDER BY a.created_at DESC LIMIT 100`).all(row.id);
  return {
    id: row.id, boardId: row.board_id, columnId: row.column_id, title: row.title, description: row.description,
    clientId: canReadClients ? row.client_id || '' : '', clientName: canReadClients ? row.client_name || '' : '',
    dueDate: row.due_date, scheduledAt:row.scheduled_at||'', scheduleMode:row.schedule_mode||'', position: row.position, archived: Boolean(row.archived),
    labels, assignees, checklist, comments, attachments, activity,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
function addBoardCardActivity(boardId,cardId,userId,action,detail='') {
  db.prepare('INSERT INTO board_card_activity (id,board_id,card_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id(),boardId,cardId,userId,action,safeText(detail,500),now());
}
function boardView(row, user) {
  const canReadClients = hasPermissionForUser(user, 'clients.read');
  const members = db.prepare(`SELECT u.id,u.name,u.profile_avatar AS avatar,u.profile_cover AS cover,u.profile_color AS color,r.name AS role,r.color AS roleColor FROM board_members bm
    JOIN users u ON u.id=bm.user_id JOIN roles r ON r.id=u.role_id
    WHERE bm.board_id=? AND u.active=1 ORDER BY u.name COLLATE NOCASE`).all(row.id).map(member => ({
    id: member.id, name: member.name, avatar:member.avatar||'',cover:member.cover||'',color:member.color||'#d8ff36',role:member.role,roleColor:member.roleColor||'#4946f5'
    }));
  const availableMembers = db.prepare(`SELECT u.id,u.name,u.profile_avatar AS avatar,u.profile_cover AS cover,u.profile_color AS color,r.name AS role,r.color AS roleColor FROM users u
    JOIN roles r ON r.id=u.role_id LEFT JOIN board_members bm ON bm.user_id=u.id AND bm.board_id=?
    WHERE u.active=1 AND bm.user_id IS NULL ORDER BY u.name COLLATE NOCASE`).all(row.id).map(member => ({
    id: member.id, name: member.name, avatar:member.avatar||'',cover:member.cover||'',color:member.color||'#d8ff36',role:member.role,roleColor:member.roleColor||'#4946f5'
    }));
  const labels = db.prepare('SELECT id,name,color,created_at AS createdAt FROM board_labels WHERE board_id=? ORDER BY name COLLATE NOCASE').all(row.id);
  const columns = db.prepare('SELECT * FROM board_columns WHERE board_id=? ORDER BY archived,position,created_at').all(row.id).map(column => ({
    id: column.id, boardId: column.board_id, name: column.name, color: column.color, position: column.position,
    workflowCategory: column.workflow_category || '',
    archived: Boolean(column.archived), createdAt: column.created_at, updatedAt: column.updated_at,
    cards: db.prepare(`SELECT board_cards.*,clients.name AS client_name FROM board_cards
      LEFT JOIN clients ON clients.id=board_cards.client_id
      WHERE board_cards.column_id=? ORDER BY board_cards.archived,board_cards.position,board_cards.created_at`).all(column.id)
      .map(card => boardCardView(card, canReadClients))
  }));
  return {
    id: row.id, name: row.name, description: row.description, archived: Boolean(row.archived),
    createdAt: row.created_at, updatedAt: row.updated_at, columns, members, availableMembers, labels
  };
}
function boardById(boardId, user) {
  const row = db.prepare('SELECT * FROM boards WHERE id=?').get(boardId);
  return row ? boardView(row, user) : null;
}
function validateBoardDate(value) {
  const date = safeText(value, 10);
  if (!date) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Informe uma data válida.'), { status: 400 });
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('Informe uma data válida.'), { status: 400 });
  }
  return date;
}
function boardLinkIds(value, field) {
  if (!Array.isArray(value)) throw Object.assign(new Error(`A lista de ${field} é inválida.`), { status: 400 });
  return [...new Set(value.map(item => safeText(item, 64)).filter(Boolean))].slice(0, 50);
}
function validateCardLinks(boardId, body) {
  const labelIds = body.labelIds === undefined ? null : boardLinkIds(body.labelIds, 'etiquetas');
  const assigneeIds = body.assigneeIds === undefined ? null : boardLinkIds(body.assigneeIds, 'responsáveis');
  if (labelIds?.length) {
    const placeholders = labelIds.map(() => '?').join(',');
    const count = db.prepare(`SELECT COUNT(*) AS count FROM board_labels WHERE board_id=? AND id IN (${placeholders})`).get(boardId, ...labelIds).count;
    if (count !== labelIds.length) throw Object.assign(new Error('Uma ou mais etiquetas não pertencem a este quadro.'), { status: 400 });
  }
  if (assigneeIds?.length) {
    const placeholders = assigneeIds.map(() => '?').join(',');
    const count = db.prepare(`SELECT COUNT(*) AS count FROM board_members bm JOIN users u ON u.id=bm.user_id WHERE bm.board_id=? AND u.active=1 AND u.id IN (${placeholders})`).get(boardId, ...assigneeIds).count;
    if (count !== assigneeIds.length) throw Object.assign(new Error('Adicione os responsáveis como membros do quadro primeiro.'), { status: 400 });
  }
  return { labelIds, assigneeIds };
}
function saveCardLinks(boardId, cardId, links, actorId) {
  if (links.labelIds !== null) {
    db.prepare('DELETE FROM board_card_labels WHERE card_id=?').run(cardId);
    const insert = db.prepare('INSERT INTO board_card_labels (card_id,label_id) VALUES (?,?)');
    links.labelIds.forEach(labelId => insert.run(cardId, labelId));
  }
  if (links.assigneeIds !== null) {
    db.prepare('DELETE FROM board_card_assignees WHERE card_id=?').run(cardId);
    const insert = db.prepare('INSERT INTO board_card_assignees (board_id,card_id,user_id,added_by,created_at) VALUES (?,?,?,?,?)');
    links.assigneeIds.forEach(userId => insert.run(boardId, cardId, userId, actorId, now()));
  }
}
function resequenceBoardCards(columnId, cardIds) {
  const update = db.prepare('UPDATE board_cards SET position=? WHERE id=? AND column_id=?');
  cardIds.forEach((cardId, position) => update.run(position, cardId, columnId));
}
function resequenceBoardColumns(boardId) {
  const columns = db.prepare('SELECT id FROM board_columns WHERE board_id=? AND archived=0 ORDER BY position,created_at').all(boardId);
  const update = db.prepare('UPDATE board_columns SET position=? WHERE id=? AND board_id=?');
  columns.forEach((column, position) => update.run(position, column.id, boardId));
}
function validateFlow(input, current, clientId) {
  const generationDay = weekdays.includes(input.generationDay) ? input.generationDay : current.generation_day;
  const postsPerCycle = Number.isInteger(Number(input.postsPerCycle)) && Number(input.postsPerCycle) >= 1 && Number(input.postsPerCycle) <= 14 ? Number(input.postsPerCycle) : current.posts_per_cycle;
  const publishDays = input.publishDays === undefined ? JSON.parse(current.publish_days) : safeList(input.publishDays, weekdays);
  const publishTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.publishTime) ? input.publishTime : current.publish_time;
  const briefingInstructions = input.briefingInstructions === undefined ? current.briefing_instructions : safeText(input.briefingInstructions, 5000);
  const imageInstructions = input.imageInstructions === undefined ? current.image_instructions : safeText(input.imageInstructions, 5000);
  const validAssetIds = new Set(db.prepare('SELECT id FROM assets WHERE client_id=?').all(clientId).map(asset => asset.id));
  const briefingAssetIds = input.briefingAssetIds === undefined ? JSON.parse(current.briefing_asset_ids) : safeList(input.briefingAssetIds).filter(assetId => validAssetIds.has(assetId));
  const imageAssetIds = input.imageAssetIds === undefined ? JSON.parse(current.image_asset_ids) : safeList(input.imageAssetIds).filter(assetId => validAssetIds.has(assetId));
  return { generationDay, postsPerCycle, publishDays, publishTime, briefingInstructions, briefingAssetIds, imageInstructions, imageAssetIds };
}
function validateClient(input, current = {}) {
  const values = { ...current, ...input };
  const name = safeText(values.name, 160);
  if (!name) throw Object.assign(new Error('Informe o nome do cliente.'), { status: 400 });
  const colors = safeList(values.brandColors).filter(v => /^#[0-9a-f]{6}$/i.test(v));
  return { name, segment: safeText(values.segment, 120), description: safeText(values.description), audience: safeText(values.audience), voice: safeText(values.voice), offerings: safeText(values.offerings),
    objectives: safeList(values.objectives, ['Posicionamento','Vendas','Marca','Informativo','Relacionamento','Autoridade','Tráfego']), contentPillars: safeList(values.contentPillars), brandColors: colors,
    postingDays: safeList(values.postingDays, ['segunda','terça','quarta','quinta','sexta','sábado','domingo']), postingTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(values.postingTime) ? values.postingTime : '09:00', autoScheduleEnabled: values.autoScheduleEnabled === true || values.autoScheduleEnabled === 1 };
}
const SCHEDULE_ZONE='America/Sao_Paulo';
function zonedParts(date){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:SCHEDULE_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);return Object.fromEntries(parts.map(part=>[part.type,part.value]));}
function localScheduleDate(date,time){const [year,month,day]=date.split('-').map(Number);const [hour,minute]=time.split(':').map(Number);const desired=Date.UTC(year,month-1,day,hour,minute);let instant=desired;for(let i=0;i<2;i++){const p=zonedParts(new Date(instant));const represented=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);instant+=desired-represented;}return new Date(instant);}
function dateInScheduleZone(date){const p=zonedParts(date);return `${p.year}-${p.month}-${p.day}`;}
function scheduleSlotKey(value){const p=zonedParts(new Date(value));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
function isScheduleSlotOccupied(value,excludeBoardCardId=''){
  const key=scheduleSlotKey(value);
  const occupied=db.prepare("SELECT scheduled_at FROM flow_runs WHERE scheduled_at<>'' AND status='approved' UNION ALL SELECT scheduled_at FROM manual_posts WHERE scheduled_at<>'' AND status='approved' UNION ALL SELECT scheduled_at FROM board_cards WHERE scheduled_at<>'' AND archived=0 AND id<>?").all(excludeBoardCardId).some(row=>scheduleSlotKey(row.scheduled_at)===key);
  return occupied;
}
function nextClientSlot(clientId,from=new Date()){
  const client=db.prepare('SELECT posting_days,posting_time,auto_schedule_enabled FROM clients WHERE id=?').get(clientId);if(!client||!client.auto_schedule_enabled)return null;
  const days=JSON.parse(client.posting_days||'[]');if(!days.length)return null;
  const weekdaysByIndex=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];const base=dateInScheduleZone(from);const [year,month,day]=base.split('-').map(Number);
  for(let offset=0;offset<90;offset++){const calendarDay=new Date(Date.UTC(year,month-1,day+offset));if(!days.includes(weekdaysByIndex[calendarDay.getUTCDay()]))continue;const date=`${calendarDay.getUTCFullYear()}-${String(calendarDay.getUTCMonth()+1).padStart(2,'0')}-${String(calendarDay.getUTCDate()).padStart(2,'0')}`;const slot=localScheduleDate(date,client.posting_time);if(slot<=from)continue;if(!isScheduleSlotOccupied(slot))return slot;}
  return null;
}
function startFlowGeneration(flow,runId,revisionNote=''){
  void (async()=>{
    try{
      const briefing=await generateBriefing(flow,revisionNote);
      db.prepare("UPDATE flow_runs SET briefing_text=?,caption_text=?,creative_spec=?,stage='image' WHERE id=?").run(briefing.text,briefing.caption,JSON.stringify(briefing.spec),runId);
      const imageFilename=await generateImage(flow,briefing.spec);
      db.prepare("UPDATE flow_runs SET image_filename=?,stage='approval',status='pending_approval' WHERE id=?").run(imageFilename,runId);
      db.prepare("UPDATE flow_runs SET stage='complete' WHERE id=?").run(runId);
    }catch(error){const message=safeText(error.message,1000)||'Falha na integração OpenAI.';db.prepare("UPDATE flow_runs SET status='failed',stage='failed',error=? WHERE id=?").run(message,runId);}
  })();
}
function handleStatic(pathname, req, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const publicDir = resolve(root, 'public');
  const file = resolve(publicDir, normalize(relative));
  if (file !== publicDir && !file.startsWith(publicDir + sep)) return fail(res, 404, 'Não encontrado.');
  if (!existsSync(file)) return fail(res, 404, 'Não encontrado.');
  const contentTypes = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
  res.writeHead(200, { 'content-type': contentTypes[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost'); const path = url.pathname; const method = req.method;
  try {
    if (method === 'GET' && path === '/api/setup-status') return send(res, 200, { setupRequired: !db.prepare('SELECT id FROM users LIMIT 1').get() });
    if (method === 'POST' && path === '/api/setup-admin') {
      if (db.prepare('SELECT id FROM users LIMIT 1').get()) return fail(res, 409, 'A configuração inicial já foi concluída.');
      const body = await jsonBody(req); const name = safeText(body.name, 120); const email = safeText(body.email, 180).toLowerCase(); const password = String(body.password || '');
      if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) return fail(res, 400, 'Informe nome, e-mail válido e senha com pelo menos 12 caracteres.');
      const userId = id(); db.prepare('INSERT INTO users (id,name,email,password_hash,role_id,active,created_at) VALUES (?,?,?,?,?,1,?)').run(userId,name,email,hashPassword(password),defaultRoleId,now());
      const token = createSession(userId);
      return send(res, 201, { user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(userId)), token }, { 'set-cookie': `3a_session=${token}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=28800` });
    }
    if (method === 'POST' && path === '/api/login') {
      const body = await jsonBody(req); const email = safeText(body.email, 180).toLowerCase(); const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
      if (!user || !passwordMatches(String(body.password || ''), user.password_hash)) return fail(res, 401, 'E-mail ou senha inválidos.');
      const token = createSession(user.id);
      return send(res, 200, { user: userView(user), token }, { 'set-cookie': `3a_session=${token}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=28800` });
    }
    if (method === 'POST' && path === '/api/reset-password') {
      const body = await jsonBody(req);
      const email = safeText(body.email, 180).toLowerCase();
      const password = String(body.password || '');
      if (!email || !password || password.length < 12) return fail(res, 400, 'Informe o e-mail e uma nova senha com no mínimo 12 caracteres.');
      const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
      if (!user) return fail(res, 404, 'Nenhum usuário ativo encontrado com este e-mail.');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      const token = createSession(user.id);
      return send(res, 200, { ok: true, user: userView(user), token }, { 'set-cookie': `3a_session=${token}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=28800` });
    }
    if (method === 'POST' && path === '/api/logout') {
      const authHeader = req.headers.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const cookieToken = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('3a_session='))?.slice('3a_session='.length);
      const token = bearerToken || cookieToken;
      if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      return send(res, 200, { ok: true }, { 'set-cookie': '3a_session=; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=0' });
    }
    if(method==='POST'&&path==='/api/session/bridge'){
      const authorization=req.headers.authorization||'';
      const oldToken=authorization.startsWith('Bearer ')?authorization.slice(7).trim():'';
      if(!oldToken)return fail(res,401,'Sessão anterior não encontrada.');
      let oldUser;
      try{
        const oldResponse=await fetch('http://127.0.0.1:3001/api/me',{headers:{authorization:`Bearer ${oldToken}`},signal:AbortSignal.timeout(2500)});
        if(!oldResponse.ok)return fail(res,401,'A sessão anterior expirou. Entre novamente para continuar.');
        oldUser=(await oldResponse.json()).user;
      }catch{return fail(res,503,'Não consegui validar a sessão do preview anterior.');}
      const user=db.prepare('SELECT * FROM users WHERE id=? AND email=? AND active=1').get(oldUser?.id,oldUser?.email);
      if(!user)return fail(res,401,'A pessoa da sessão anterior não existe mais neste banco.');
      const token=createSession(user.id);
      return send(res,200,{token,user:userView(user)});
    }
    if (method === 'GET' && path === '/api/me') { const user = sessionFor(req); return user ? send(res, 200, { user: userView(user) }) : fail(res, 401, 'Sessão encerrada.'); }
    if(path==='/api/integrations/instagram'&&method==='GET'){
      if(!requirePermission(req,res,'settings.view'))return;const config=instagramAppConfig();return send(res,200,{configured:Boolean(config.appId&&config.appSecret),appId:config.appId||'',source:process.env.META_INSTAGRAM_APP_SECRET?'environment':'local',redirectUri:instagramRedirectUri(req)});
    }
    if(path==='/api/integrations/instagram'&&method==='PUT'){
      if(!requirePermission(req,res,'settings.manage'))return;const body=await jsonBody(req),appId=safeText(body.appId,24),appSecret=safeText(body.appSecret,300);
      if(!/^\d{10,20}$/.test(appId))return fail(res,400,'Informe o ID do app do Instagram indicado pela Meta.');
      if(appSecret.length<12)return fail(res,400,'Cole a chave secreta do app do Instagram.');
      if(process.env.META_INSTAGRAM_APP_ID||process.env.META_INSTAGRAM_APP_SECRET)return fail(res,409,'As credenciais Meta estão definidas no ambiente do servidor.');
      db.prepare("INSERT INTO settings(key,value) VALUES('instagram_app_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encryptInstagramSecret(JSON.stringify({appId,appSecret})));
      return send(res,200,{configured:true,appId,source:'local',redirectUri:instagramRedirectUri(req)});
    }
    const instagramConnect=path.match(/^\/api\/clients\/([a-f0-9]+)\/instagram\/connect$/);
    if(instagramConnect&&method==='POST'){
      const user=requirePermission(req,res,'clients.write');if(!user)return;const client=db.prepare('SELECT id FROM clients WHERE id=?').get(instagramConnect[1]);if(!client)return fail(res,404,'Cliente não encontrado.');const config=instagramAppConfig();if(!config.appId||!config.appSecret)return fail(res,409,'Configure primeiro as credenciais do Instagram em Configurações.');
      db.prepare('DELETE FROM instagram_oauth_states WHERE expires_at<=?').run(now());const stateToken=randomBytes(32).toString('base64url'),redirectUri=instagramRedirectUri(req),returnOrigin=trustedReturnOrigin(req);db.prepare('INSERT INTO instagram_oauth_states(state,user_id,client_id,return_origin,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(stateToken,user.id,client.id,returnOrigin,new Date(Date.now()+10*60*1000).toISOString(),now());
      const authorize=new URL('https://www.instagram.com/oauth/authorize');authorize.searchParams.set('client_id',config.appId);authorize.searchParams.set('redirect_uri',redirectUri);authorize.searchParams.set('response_type','code');authorize.searchParams.set('scope','instagram_business_basic,instagram_business_content_publish');authorize.searchParams.set('state',stateToken);authorize.searchParams.set('enable_fb_login','0');authorize.searchParams.set('force_authentication','1');return send(res,200,{authorizeUrl:authorize.toString()});
    }
    if(path==='/api/integrations/instagram/callback'&&method==='GET'){
      const stateToken=safeText(url.searchParams.get('state'),100),stateRow=stateToken?db.prepare('SELECT * FROM instagram_oauth_states WHERE state=?').get(stateToken):null;const failUrl=stateRow?`${stateRow.return_origin}/?instagram=error#clients`:'http://127.0.0.1:3001/?instagram=error#clients';
      if(!stateRow||stateRow.expires_at<=now()){return res.writeHead(302,{location:failUrl}).end();}
      db.prepare('DELETE FROM instagram_oauth_states WHERE state=?').run(stateToken);
      const providerError=url.searchParams.get('error_description')||url.searchParams.get('error_reason')||url.searchParams.get('error');if(providerError){const target=new URL(failUrl);target.searchParams.set('instagram_message',safeText(providerError,150));return res.writeHead(302,{location:target.toString()}).end();}
      const code=safeText(url.searchParams.get('code'),2048),user=db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(stateRow.user_id),client=db.prepare('SELECT id FROM clients WHERE id=?').get(stateRow.client_id),config=instagramAppConfig();if(!code||!user||!client||!config.appId||!config.appSecret)return res.writeHead(302,{location:failUrl}).end();
      try{
        const redirectUri=instagramRedirectUri(req),form=new URLSearchParams({client_id:config.appId,client_secret:config.appSecret,grant_type:'authorization_code',redirect_uri:redirectUri,code});const exchange=await fetch('https://api.instagram.com/oauth/access_token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(20000)});const shortToken=await exchange.json().catch(()=>({}));if(!exchange.ok||!shortToken.access_token)throw new Error('A Meta não concluiu a troca do código de autorização.');
        const longUrl=new URL('https://graph.instagram.com/access_token');longUrl.searchParams.set('grant_type','ig_exchange_token');longUrl.searchParams.set('client_secret',config.appSecret);longUrl.searchParams.set('access_token',shortToken.access_token);const longResponse=await fetch(longUrl,{signal:AbortSignal.timeout(20000)}),longToken=await longResponse.json().catch(()=>({}));if(!longResponse.ok||!longToken.access_token)throw new Error('A Meta não retornou um token de longa duração.');
        const profileUrl=new URL('https://graph.instagram.com/me');profileUrl.searchParams.set('fields','user_id,username,account_type');profileUrl.searchParams.set('access_token',longToken.access_token);const profileResponse=await fetch(profileUrl,{signal:AbortSignal.timeout(20000)}),profile=await profileResponse.json().catch(()=>({}));if(!profileResponse.ok||!(profile.user_id||profile.id))throw new Error('Não foi possível ler o perfil profissional autorizado.');
        const stamp=now(),expiresAt=new Date(Date.now()+Number(longToken.expires_in||5184000)*1000).toISOString();db.prepare(`INSERT INTO client_instagram_accounts(client_id,instagram_user_id,username,account_type,access_token_encrypted,token_expires_at,connected_by,connected_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET instagram_user_id=excluded.instagram_user_id,username=excluded.username,account_type=excluded.account_type,access_token_encrypted=excluded.access_token_encrypted,token_expires_at=excluded.token_expires_at,connected_by=excluded.connected_by,connected_at=excluded.connected_at,updated_at=excluded.updated_at`).run(client.id,String(profile.user_id||profile.id),safeText(profile.username,120),safeText(profile.account_type,40),encryptInstagramSecret(longToken.access_token),expiresAt,user.id,stamp,stamp);
        return res.writeHead(302,{location:`${stateRow.return_origin}/?instagram=connected#clients`}).end();
      }catch(error){console.error('[Instagram OAuth]',error.message);const target=new URL(failUrl);target.searchParams.set('instagram_message','Não foi possível concluir a conexão. Confira o Redirect URI e as credenciais da Meta.');return res.writeHead(302,{location:target.toString()}).end();}
    }
    if(method==='GET'&&path==='/api/changes'){const user=sessionFor(req);if(!user)return fail(res,401,'Entre na plataforma para continuar.');const since=Math.max(0,Number(url.searchParams.get('since'))||0);const state=db.prepare('SELECT revision,changed_at AS changedAt FROM workspace_state WHERE id=1').get();const changes=db.prepare('SELECT revision,actor_id AS actorId,client_id AS clientId,changed_at AS changedAt FROM workspace_changes WHERE revision>? ORDER BY revision LIMIT 100').all(since);return send(res,200,{...state,changes});}
    if(path==='/api/profile'&&method==='PUT'){
      const user=sessionFor(req);if(!user)return fail(res,401,'Entre na plataforma para continuar.');
      const body=await jsonBody(req);const name=safeText(body.name,120);const avatar=safeText(body.avatar,40);const cover=safeText(body.cover,40);const color=safeText(body.color,20);
      const avatars=['orbit','spark','wave','leaf','pixel','sun','moon','bolt','flower','gem','fox','cat'];const covers=['lime','violet','blue','sunset','mint','ink'];const colors=['#d8ff36','#4946f5','#bba4ff','#ff6b8a','#27ae73','#ff9f43','#22a6b3','#1d2825'];
      if(!name||!colors.includes(color)||!avatars.includes(avatar)||!covers.includes(cover))return fail(res,400,'Confira o nome e escolha uma opção disponível para foto, capa e cor.');
      db.prepare('UPDATE users SET name=?,profile_avatar=?,profile_cover=?,profile_color=? WHERE id=?').run(name,avatar,cover,color,user.id);
      return send(res,200,{user:userView(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))});
    }
    if(path==='/api/team-profiles'&&method==='GET'){
      if(!sessionFor(req))return fail(res,401,'Entre na plataforma para continuar.');
      const users=db.prepare('SELECT u.id,u.name,u.profile_avatar AS avatar,u.profile_cover AS cover,u.profile_color AS color,r.name AS role,r.color AS roleColor FROM users u JOIN roles r ON r.id=u.role_id WHERE u.active=1 ORDER BY u.name COLLATE NOCASE').all();
      return send(res,200,{users});
    }
    const publicProfileMatch=path.match(/^\/api\/users\/([a-f0-9]+)\/profile$/);if(publicProfileMatch&&method==='GET'){
      if(!sessionFor(req))return fail(res,401,'Entre na plataforma para continuar.');
      const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(publicProfileMatch[1]);if(!user)return fail(res,404,'Pessoa não encontrada.');
      const cards=db.prepare(`SELECT c.id,c.title,b.name AS board_name,bc.name AS column_name,c.due_date FROM board_card_assignees ca JOIN board_cards c ON c.id=ca.card_id JOIN boards b ON b.id=c.board_id JOIN board_columns bc ON bc.id=c.column_id WHERE ca.user_id=? AND c.archived=0 AND b.archived=0 ORDER BY c.due_date LIMIT 8`).all(user.id);
      return send(res,200,{user:userView(user),cards});
    }
    if (path === '/api/integrations/openai' && method === 'GET') {
      if (!requirePermission(req,res,'settings.view')) return;
      return send(res,200,{configured:openAiConfigured(),source:process.env.OPENAI_API_KEY?'environment':'local'});
    }
    if (path === '/api/integrations/openai' && method === 'PUT') {
      if (!requirePermission(req,res,'settings.manage')) return;
      const key=safeText((await jsonBody(req)).apiKey,300);
      if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return fail(res,400,'Informe uma chave OpenAI válida.');
      if (process.env.OPENAI_API_KEY) return fail(res,409,'A chave está definida no ambiente do servidor.');
      writeFileSync(openAiKeyPath,key,{encoding:'utf8',mode:0o600});
      return send(res,200,{configured:true,source:'local'});
    }

    if (path === '/api/boards' && method === 'GET') {
      const user=requirePermission(req,res,'boards.read'); if(!user)return;
      const boards=db.prepare('SELECT * FROM boards ORDER BY archived,updated_at DESC,name COLLATE NOCASE').all()
        .map(board=>boardView(board,user));
      return send(res,200,{boards});
    }
    const boardMembersPath=path.match(/^\/api\/boards\/([a-f0-9]+)\/members$/);
    if(boardMembersPath&&method==='GET'){
      const user=requirePermission(req,res,'boards.read'); if(!user)return;
      const board=db.prepare('SELECT id FROM boards WHERE id=?').get(boardMembersPath[1]); if(!board)return fail(res,404,'Quadro não encontrado.');
      const members=db.prepare(`SELECT u.id,u.name,r.name AS role,r.permissions FROM board_members bm JOIN users u ON u.id=bm.user_id JOIN roles r ON r.id=u.role_id WHERE bm.board_id=? AND u.active=1 ORDER BY u.name COLLATE NOCASE`).all(board.id).map(m=>({id:m.id,name:m.name,role:m.role,permissions:JSON.parse(m.permissions)}));
      const available=db.prepare(`SELECT u.id,u.name,r.name AS role,r.permissions FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN board_members bm ON bm.board_id=? AND bm.user_id=u.id WHERE u.active=1 AND bm.user_id IS NULL ORDER BY u.name COLLATE NOCASE`).all(board.id).map(m=>({id:m.id,name:m.name,role:m.role,permissions:JSON.parse(m.permissions)}));
      return send(res,200,{members,available});
    }
    if(boardMembersPath&&method==='POST'){
      const actor=requireBoardWrite(req,res); if(!actor)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardMembersPath[1]); if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de adicionar pessoas.');
      const userId=safeText((await jsonBody(req)).userId,64); const member=db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(userId); if(!member)return fail(res,400,'Escolha uma pessoa ativa da equipe.');
      db.prepare('INSERT OR IGNORE INTO board_members (board_id,user_id,added_by,created_at) VALUES (?,?,?,?)').run(board.id,userId,actor.id,now());
      return send(res,201,{board:boardById(board.id,actor)});
    }
    const boardMemberDelete=path.match(/^\/api\/boards\/([a-f0-9]+)\/members\/([a-f0-9]+)$/);
    if(boardMemberDelete&&method==='DELETE'){
      const actor=requireBoardWrite(req,res); if(!actor)return;
      const board=db.prepare('SELECT id FROM boards WHERE id=?').get(boardMemberDelete[1]); if(!board)return fail(res,404,'Quadro não encontrado.');
      db.prepare('DELETE FROM board_members WHERE board_id=? AND user_id=?').run(board.id,boardMemberDelete[2]);
      return send(res,200,{board:boardById(board.id,actor)});
    }
    const boardLabelsPath=path.match(/^\/api\/boards\/([a-f0-9]+)\/labels$/);
    if(boardLabelsPath&&method==='POST'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardLabelsPath[1]); if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de editar etiquetas.');
      const body=await jsonBody(req); const name=safeText(body.name,40); const color=safeText(body.color,16);
      if(!name)return fail(res,400,'Dê um nome para a etiqueta.'); if(!/^#[0-9a-f]{6}$/i.test(color))return fail(res,400,'Escolha uma cor válida.');
      const labelId=id(); try { db.prepare('INSERT INTO board_labels (id,board_id,name,color,created_at) VALUES (?,?,?,?,?)').run(labelId,board.id,name,color,now()); }
      catch { return fail(res,409,'Já existe uma etiqueta com esse nome neste quadro.'); }
      return send(res,201,{label:db.prepare('SELECT id,name,color,created_at AS createdAt FROM board_labels WHERE id=?').get(labelId)});
    }
    const boardLabelPath=path.match(/^\/api\/boards\/([a-f0-9]+)\/labels\/([a-f0-9]+)$/);
    if(boardLabelPath&&method==='PUT'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const label=db.prepare('SELECT * FROM board_labels WHERE id=? AND board_id=?').get(boardLabelPath[2],boardLabelPath[1]); if(!label)return fail(res,404,'Etiqueta não encontrada.');
      const body=await jsonBody(req); const name=safeText(body.name,40); const color=safeText(body.color,16);
      if(!name)return fail(res,400,'Dê um nome para a etiqueta.'); if(!/^#[0-9a-f]{6}$/i.test(color))return fail(res,400,'Escolha uma cor válida.');
      try { db.prepare('UPDATE board_labels SET name=?,color=? WHERE id=?').run(name,color,label.id); }
      catch { return fail(res,409,'Já existe uma etiqueta com esse nome neste quadro.'); }
      return send(res,200,{label:db.prepare('SELECT id,name,color,created_at AS createdAt FROM board_labels WHERE id=?').get(label.id)});
    }
    if(boardLabelPath&&method==='DELETE'){
      if(!requireBoardWrite(req,res))return;
      db.prepare('DELETE FROM board_labels WHERE id=? AND board_id=?').run(boardLabelPath[2],boardLabelPath[1]);
      return send(res,200,{ok:true});
    }
    if (path === '/api/boards' && method === 'POST') {
      const user=requireBoardWrite(req,res); if(!user)return;
      const body=await jsonBody(req); const name=safeText(body.name,100); const description=safeText(body.description,1000);
      if(!name)return fail(res,400,'Informe o nome do quadro.');
      const boardId=id(); const stamp=now();
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO boards (id,name,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)')
          .run(boardId,name,description,user.id,stamp,stamp);
        db.prepare('INSERT INTO board_members (board_id,user_id,added_by,created_at) VALUES (?,?,?,?)').run(boardId,user.id,user.id,stamp);
        const createColumn=db.prepare('INSERT INTO board_columns (id,board_id,name,color,position,workflow_category,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
        [['A fazer','#d8ff36','intake'],['Em andamento','#bba4ff','production'],['Concluído','#dce9df','completed']]
          .forEach(([columnName,color,category],position)=>createColumn.run(id(),boardId,columnName,color,position,category,stamp,stamp));
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      return send(res,201,{board:boardById(boardId,user)});
    }
    const boardMatch=path.match(/^\/api\/boards\/([a-f0-9]+)$/);
    if(boardMatch&&method==='PUT'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT * FROM boards WHERE id=?').get(boardMatch[1]); if(!board)return fail(res,404,'Quadro não encontrado.');
      const body=await jsonBody(req); const name=body.name===undefined?board.name:safeText(body.name,100);
      const description=body.description===undefined?board.description:safeText(body.description,1000);
      if(!name)return fail(res,400,'Informe o nome do quadro.');
      if(body.archived!==undefined&&typeof body.archived!=='boolean')return fail(res,400,'Estado de arquivamento inválido.');
      const archived=body.archived===undefined?board.archived:(body.archived?1:0); const stamp=now();
      db.prepare('UPDATE boards SET name=?,description=?,archived=?,updated_at=? WHERE id=?').run(name,description,archived,stamp,board.id);
      return send(res,200,{board:boardById(board.id,user)});
    }
    const boardColumnReorder=path.match(/^\/api\/boards\/([a-f0-9]+)\/columns\/reorder$/);
    if(boardColumnReorder&&method==='POST'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardColumnReorder[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de reorganizar as colunas.');
      const body=await jsonBody(req); const ids=Array.isArray(body.columnIds)?body.columnIds.map(value=>safeText(value,64)):[];
      const activeIds=db.prepare('SELECT id FROM board_columns WHERE board_id=? AND archived=0 ORDER BY position,created_at').all(board.id).map(column=>column.id);
      if(ids.length!==activeIds.length||new Set(ids).size!==ids.length||activeIds.some(columnId=>!ids.includes(columnId)))return fail(res,400,'A ordem das colunas é inválida.');
      const update=db.prepare('UPDATE board_columns SET position=?,updated_at=? WHERE id=? AND board_id=?');
      const stamp=now();
      db.exec('BEGIN');
      try { ids.forEach((columnId,position)=>update.run(position,stamp,columnId,board.id)); db.exec('COMMIT'); }
      catch(error) { db.exec('ROLLBACK'); throw error; }
      return send(res,200,{ok:true});
    }
    const boardColumns=path.match(/^\/api\/boards\/([a-f0-9]+)\/columns$/);
    if(boardColumns&&method==='POST'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardColumns[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de criar uma coluna.');
      const body=await jsonBody(req); const name=safeText(body.name,80); const color=body.color===undefined?'#d8ff36':safeText(body.color,16);
      if(!name)return fail(res,400,'Informe o nome da coluna.');
      if(!/^#[0-9a-f]{6}$/i.test(color))return fail(res,400,'Escolha uma cor válida para a coluna.');
      const columnId=id(); const stamp=now(); const position=db.prepare('SELECT COUNT(*) AS count FROM board_columns WHERE board_id=? AND archived=0').get(board.id).count;
      db.prepare('INSERT INTO board_columns (id,board_id,name,color,position,workflow_category,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(columnId,board.id,name,color,position,'',stamp,stamp);
      const column=boardById(board.id,user).columns.find(item=>item.id===columnId);
      return send(res,201,{column});
    }
    const boardColumnMatch=path.match(/^\/api\/boards\/([a-f0-9]+)\/columns\/([a-f0-9]+)$/);
    if(boardColumnMatch&&method==='PUT'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardColumnMatch[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de editar suas colunas.');
      const column=db.prepare('SELECT * FROM board_columns WHERE id=? AND board_id=?').get(boardColumnMatch[2],board.id);
      if(!column)return fail(res,404,'Coluna não encontrada.');
      const body=await jsonBody(req); const name=body.name===undefined?column.name:safeText(body.name,80);
      const color=body.color===undefined?column.color:safeText(body.color,16);
      const workflowCategory=body.workflowCategory===undefined?(column.workflow_category||''):safeText(body.workflowCategory,40);
      if(!name)return fail(res,400,'Informe o nome da coluna.');
      if(!/^#[0-9a-f]{6}$/i.test(color))return fail(res,400,'Escolha uma cor válida para a coluna.');
      if(workflowCategory&&!Object.hasOwn(BOARD_WORKFLOW_CATEGORIES,workflowCategory))return fail(res,400,'Escolha uma categoria de fluxo válida.');
      if(body.archived!==undefined&&typeof body.archived!=='boolean')return fail(res,400,'Estado de arquivamento inválido.');
      const archived=body.archived===undefined?column.archived:(body.archived?1:0);
      if(workflowCategory&&archived===0){
        const taken=db.prepare('SELECT name FROM board_columns WHERE board_id=? AND workflow_category=? AND archived=0 AND id<>?').get(board.id,workflowCategory,column.id);
        if(taken)return fail(res,409,`A categoria “${BOARD_WORKFLOW_CATEGORIES[workflowCategory]}” já está usada na coluna “${taken.name}”.`);
      }
      const nextPosition=column.archived&&!archived
        ?db.prepare('SELECT COUNT(*) AS count FROM board_columns WHERE board_id=? AND archived=0').get(board.id).count
        :column.position;
      const stamp=now();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE board_columns SET name=?,color=?,position=?,archived=?,workflow_category=?,updated_at=? WHERE id=?').run(name,color,nextPosition,archived,workflowCategory,stamp,column.id);
        resequenceBoardColumns(board.id);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      const result=boardById(board.id,user).columns.find(item=>item.id===column.id);
      return send(res,200,{column:result});
    }
    const boardReset=path.match(/^\/api\/boards\/([a-f0-9]+)\/reset$/);
    if(boardReset&&method==='POST'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardReset[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de reiniciá-lo.');
      const stamp=now(); const freshColumnId=id();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE board_cards SET archived=1,updated_by=?,updated_at=? WHERE board_id=? AND archived=0').run(user.id,stamp,board.id);
        db.prepare('UPDATE board_columns SET archived=1,updated_at=? WHERE board_id=? AND archived=0').run(stamp,board.id);
        db.prepare('INSERT INTO board_columns (id,board_id,name,color,position,workflow_category,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(freshColumnId,board.id,'A fazer','#d8ff36',0,'intake',stamp,stamp);
        db.prepare('UPDATE boards SET updated_at=? WHERE id=?').run(stamp,board.id);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      return send(res,200,{board:boardById(board.id,user)});
    }
    const boardCards=path.match(/^\/api\/boards\/([a-f0-9]+)\/cards$/);
    if(boardCards&&method==='POST'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardCards[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de adicionar cartões.');
      const body=await jsonBody(req); const title=safeText(body.title,180); const description=safeText(body.description,5000);
      const columnId=safeText(body.columnId,64); const column=db.prepare('SELECT id FROM board_columns WHERE id=? AND board_id=? AND archived=0').get(columnId,board.id);
      if(!title)return fail(res,400,'Informe o título do cartão.'); if(!column)return fail(res,400,'Escolha uma coluna ativa deste quadro.');
      const clientId=safeText(body.clientId,64);
      if(clientId&&!hasPermissionForUser(user,'clients.read'))return fail(res,403,'Seu cargo não pode associar clientes aos cartões.');
      if(clientId&&!db.prepare('SELECT id FROM clients WHERE id=?').get(clientId))return fail(res,400,'O cliente selecionado não existe.');
      let links; try { links=validateCardLinks(board.id,body); } catch(error) { return fail(res,error.status||400,error.message); }
      const dueDate=validateBoardDate(body.dueDate); const position=db.prepare('SELECT COUNT(*) AS count FROM board_cards WHERE column_id=? AND archived=0').get(column.id).count;
      const cardId=id(); const stamp=now();
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO board_cards (id,board_id,column_id,title,description,client_id,due_date,position,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(cardId,board.id,column.id,title,description,clientId||null,dueDate,position,user.id,user.id,stamp,stamp);
        saveCardLinks(board.id,cardId,links,user.id);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      addBoardCardActivity(board.id,cardId,user.id,'created','criou o cartão');
      const card=boardById(board.id,user).columns.flatMap(item=>item.cards).find(item=>item.id===cardId);
      return send(res,201,{card});
    }
    const boardCardMove=path.match(/^\/api\/boards\/([a-f0-9]+)\/cards\/([a-f0-9]+)\/move$/);
    if(boardCardMove&&method==='POST'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardCardMove[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de mover cartões.');
      const card=db.prepare('SELECT * FROM board_cards WHERE id=? AND board_id=?').get(boardCardMove[2],board.id);
      if(!card)return fail(res,404,'Cartão não encontrado.'); if(card.archived)return fail(res,409,'Restaure o cartão antes de movê-lo.');
      const body=await jsonBody(req); const columnId=safeText(body.columnId,64);
      const target=db.prepare('SELECT id FROM board_columns WHERE id=? AND board_id=? AND archived=0').get(columnId,board.id);
      if(!target)return fail(res,400,'Escolha uma coluna ativa deste quadro.');
      const requestedPosition=Number(body.position);
      if(!Number.isInteger(requestedPosition))return fail(res,400,'A posição do cartão é inválida.');
      const targetCards=db.prepare('SELECT id FROM board_cards WHERE column_id=? AND archived=0 AND id<>? ORDER BY position,created_at').all(target.id,card.id).map(item=>item.id);
      const position=Math.max(0,Math.min(requestedPosition,targetCards.length)); targetCards.splice(position,0,card.id);
      const stamp=now();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE board_cards SET column_id=?,position=?,updated_by=?,updated_at=? WHERE id=?').run(target.id,position,user.id,stamp,card.id);
        resequenceBoardCards(target.id,targetCards);
        if(card.column_id!==target.id){
          const sourceIds=db.prepare('SELECT id FROM board_cards WHERE column_id=? AND archived=0 ORDER BY position,created_at').all(card.column_id).map(item=>item.id);
          resequenceBoardCards(card.column_id,sourceIds);
        }
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      if(card.column_id!==target.id)addBoardCardActivity(board.id,card.id,user.id,'moved',`moveu para ${db.prepare('SELECT name FROM board_columns WHERE id=?').get(target.id)?.name||'outra coluna'}`);
      const moved=boardById(board.id,user).columns.flatMap(item=>item.cards).find(item=>item.id===card.id);
      return send(res,200,{card:moved});
    }
    const boardCardMatch=path.match(/^\/api\/boards\/([a-f0-9]+)\/cards\/([a-f0-9]+)$/);
    const boardCardSchedule=path.match(/^\/api\/boards\/([a-f0-9]+)\/cards\/([a-f0-9]+)\/schedule$/);
    if(boardCardSchedule&&method==='POST'){
      const user=requireBoardWrite(req,res);if(!user)return;
      if(!requirePermission(req,res,'clients.read'))return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardCardSchedule[1]);if(!board)return fail(res,404,'Quadro não encontrado.');if(board.archived)return fail(res,409,'Restaure o quadro antes de programar cartões.');
      const card=db.prepare('SELECT * FROM board_cards WHERE id=? AND board_id=?').get(boardCardSchedule[2],board.id);if(!card)return fail(res,404,'Cartão não encontrado.');
      const column=db.prepare('SELECT workflow_category FROM board_columns WHERE id=? AND board_id=?').get(card.column_id,board.id);if(column?.workflow_category!=='schedule')return fail(res,409,'A programação só está disponível em uma coluna categorizada como Programar.');
      if(!card.client_id)return fail(res,400,'Associe um cliente ao cartão antes de programar.');
      const body=await jsonBody(req);let scheduled=null,mode=body.mode;
      if(mode==='clear'){
        db.prepare("UPDATE board_cards SET scheduled_at='',schedule_mode='',updated_by=?,updated_at=? WHERE id=?").run(user.id,now(),card.id);
        addBoardCardActivity(board.id,card.id,user.id,'schedule_cleared','removeu o agendamento deste cartão');
      }else if(mode==='automatic'){
        scheduled=nextClientSlot(card.client_id);if(!scheduled)return fail(res,409,'Ative o agendamento automático e escolha dias de publicação nas configurações do cliente.');
        mode='automatic';
      }else if(mode==='manual'){
        const raw=safeText(body.scheduledAt,32),match=raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
        if(!match||+match[2]>23||+match[3]>59)return fail(res,400,'Escolha uma data e um horário válidos.');
        scheduled=localScheduleDate(match[1],`${match[2]}:${match[3]}`);if(scheduled<=new Date())return fail(res,400,'Escolha uma data e um horário futuros.');
        if(isScheduleSlotOccupied(scheduled,card.id))return fail(res,409,'Esse horário já está reservado para outro conteúdo. Escolha outro horário.');
      }else return fail(res,400,'Escolha agendamento automático ou manual.');
      if(scheduled){const stamp=now();db.prepare('UPDATE board_cards SET scheduled_at=?,schedule_mode=?,updated_by=?,updated_at=? WHERE id=?').run(scheduled.toISOString(),mode,user.id,stamp,card.id);addBoardCardActivity(board.id,card.id,user.id,'scheduled',`${mode==='automatic'?'agendou automaticamente':'agendou manualmente'} para ${new Intl.DateTimeFormat('pt-BR',{timeZone:SCHEDULE_ZONE,dateStyle:'short',timeStyle:'short'}).format(scheduled)}`);}
      const updated=boardById(board.id,user).columns.flatMap(item=>item.cards).find(item=>item.id===card.id);return send(res,200,{card:updated,timeZone:SCHEDULE_ZONE});
    }
    if(boardCardMatch&&method==='PUT'){
      const user=requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardCardMatch[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.'); if(board.archived)return fail(res,409,'Restaure o quadro antes de editar cartões.');
      const card=db.prepare('SELECT * FROM board_cards WHERE id=? AND board_id=?').get(boardCardMatch[2],board.id);
      if(!card)return fail(res,404,'Cartão não encontrado.');
      const body=await jsonBody(req); const title=body.title===undefined?card.title:safeText(body.title,180);
      const description=body.description===undefined?card.description:safeText(body.description,5000);
      if(!title)return fail(res,400,'Informe o título do cartão.');
      let clientId=card.client_id;
      if(body.clientId!==undefined){
        clientId=safeText(body.clientId,64);
        if(clientId&&!hasPermissionForUser(user,'clients.read'))return fail(res,403,'Seu cargo não pode associar clientes aos cartões.');
        if(clientId&&!db.prepare('SELECT id FROM clients WHERE id=?').get(clientId))return fail(res,400,'O cliente selecionado não existe.');
      }
      const dueDate=body.dueDate===undefined?card.due_date:validateBoardDate(body.dueDate);
      let links; try { links=validateCardLinks(board.id,body); } catch(error) { return fail(res,error.status||400,error.message); }
      if(body.archived!==undefined&&typeof body.archived!=='boolean')return fail(res,400,'Estado de arquivamento inválido.');
      const archived=body.archived===undefined?Boolean(card.archived):body.archived;
      if(card.archived&&!archived){
        const column=db.prepare('SELECT archived FROM board_columns WHERE id=?').get(card.column_id);
        if(!column||column.archived)return fail(res,409,'Restaure a coluna antes de restaurar este cartão.');
      }
      const nextPosition=card.archived&&!archived
        ?db.prepare('SELECT COUNT(*) AS count FROM board_cards WHERE column_id=? AND archived=0').get(card.column_id).count
        :card.position;
      const stamp=now();
      db.exec('BEGIN');
      try {
        const clientChanged=String(card.client_id||'')!==String(clientId||''),scheduledAt=clientChanged?'':card.scheduled_at,scheduleMode=clientChanged?'':card.schedule_mode;
        db.prepare('UPDATE board_cards SET title=?,description=?,client_id=?,due_date=?,position=?,archived=?,scheduled_at=?,schedule_mode=?,updated_by=?,updated_at=? WHERE id=?')
          .run(title,description,clientId||null,dueDate,nextPosition,archived?1:0,scheduledAt,scheduleMode,user.id,stamp,card.id);
        saveCardLinks(board.id,card.id,links,user.id);
        if((!card.archived&&archived)||(card.archived&&!archived)){
          const activeIds=db.prepare('SELECT id FROM board_cards WHERE column_id=? AND archived=0 ORDER BY position,created_at').all(card.column_id).map(item=>item.id);
          resequenceBoardCards(card.column_id,activeIds);
        }
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      const changes=[];
      if(card.title!==title)changes.push('o título');
      if(card.description!==description)changes.push('a descrição');
      if(String(card.client_id||'')!==String(clientId||''))changes.push('o cliente');
      if(String(card.client_id||'')!==String(clientId||'')&&card.scheduled_at)addBoardCardActivity(board.id,card.id,user.id,'schedule_cleared','removeu o agendamento porque o cliente do cartão foi alterado');
      if(String(card.due_date||'')!==String(dueDate||''))changes.push('o prazo');
      if(Boolean(card.archived)!==Boolean(archived))addBoardCardActivity(board.id,card.id,user.id,archived?'archived':'restored',archived?'arquivou o cartão':'restaurou o cartão');
      const oldLabels=db.prepare('SELECT label_id AS id FROM board_card_labels WHERE card_id=? ORDER BY label_id').all(card.id).map(item=>item.id);
      const oldAssignees=db.prepare('SELECT user_id AS id FROM board_card_assignees WHERE card_id=? ORDER BY user_id').all(card.id).map(item=>item.id);
      if(links.labelIds!==null&&[...links.labelIds].sort().join('|')!==oldLabels.join('|'))changes.push('as etiquetas');
      if(links.assigneeIds!==null&&[...links.assigneeIds].sort().join('|')!==oldAssignees.join('|'))changes.push('os responsáveis');
      if(changes.length)addBoardCardActivity(board.id,card.id,user.id,'updated',`atualizou ${changes.join(', ')}`);
      const updated=boardById(board.id,user).columns.flatMap(item=>item.cards).find(item=>item.id===card.id);
      return send(res,200,{card:updated});
    }

    const boardCardResource=path.match(/^\/api\/boards\/([a-f0-9]+)\/cards\/([a-f0-9]+)\/(comments|checklist|attachments)(?:\/([a-f0-9]+))?$/);
    if(boardCardResource){
      const user=method==='GET'?requirePermission(req,res,'boards.read'):requireBoardWrite(req,res); if(!user)return;
      const board=db.prepare('SELECT id,archived FROM boards WHERE id=?').get(boardCardResource[1]);
      if(!board)return fail(res,404,'Quadro não encontrado.');
      const card=db.prepare('SELECT id FROM board_cards WHERE id=? AND board_id=?').get(boardCardResource[2],board.id);
      if(!card)return fail(res,404,'Cartão não encontrado.');
      const resource=boardCardResource[3];
      if(resource==='comments'&&method==='POST'){
        const body=safeText((await jsonBody(req)).body,3000); if(!body)return fail(res,400,'Escreva um comentário antes de enviar.');
        const commentId=id(),stamp=now();
        db.prepare('INSERT INTO board_card_comments (id,board_id,card_id,user_id,body,created_at) VALUES (?,?,?,?,?,?)').run(commentId,board.id,card.id,user.id,body,stamp);
        addBoardCardActivity(board.id,card.id,user.id,'commented','adicionou um comentário');
        const comment=db.prepare(`SELECT c.id,c.body,c.created_at AS createdAt,u.id AS userId,u.name AS userName FROM board_card_comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(commentId);
        return send(res,201,{comment});
      }
      if(resource==='checklist'&&method==='POST'){
        const body=await jsonBody(req),title=safeText(body.title,200); if(!title)return fail(res,400,'Informe o texto do item.');
        const itemId=id(),stamp=now(),position=db.prepare('SELECT COUNT(*) AS count FROM board_card_checklist WHERE card_id=?').get(card.id).count;
        db.prepare('INSERT INTO board_card_checklist (id,board_id,card_id,title,completed,position,created_by,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?,?)').run(itemId,board.id,card.id,title,position,user.id,stamp,stamp);
        addBoardCardActivity(board.id,card.id,user.id,'checklist','adicionou um item à checklist');
        return send(res,201,{item:db.prepare('SELECT id,title,completed,position,created_at AS createdAt,updated_at AS updatedAt FROM board_card_checklist WHERE id=?').get(itemId)});
      }
      const checklistItem=boardCardResource[4]&&resource==='checklist'?boardCardResource:null;
      if(resource==='checklist'&&checklistItem&&method==='PUT'){
        const item=db.prepare('SELECT * FROM board_card_checklist WHERE id=? AND board_id=? AND card_id=?').get(checklistItem[4],board.id,card.id); if(!item)return fail(res,404,'Item não encontrado.');
        const body=await jsonBody(req),title=body.title===undefined?item.title:safeText(body.title,200);
        if(!title)return fail(res,400,'Informe o texto do item.'); if(body.completed!==undefined&&typeof body.completed!=='boolean')return fail(res,400,'Estado inválido.');
        const completed=body.completed===undefined?item.completed:(body.completed?1:0),stamp=now();
        db.prepare('UPDATE board_card_checklist SET title=?,completed=?,updated_at=? WHERE id=?').run(title,completed,stamp,item.id);
        addBoardCardActivity(board.id,card.id,user.id,completed!==item.completed?'checklist':'updated',completed!==item.completed?(completed?'concluiu um item da checklist':'reabriu um item da checklist'):'editou um item da checklist');
        return send(res,200,{item:db.prepare('SELECT id,title,completed,position,created_at AS createdAt,updated_at AS updatedAt FROM board_card_checklist WHERE id=?').get(item.id)});
      }
      if(resource==='checklist'&&checklistItem&&method==='DELETE'){
        const result=db.prepare('DELETE FROM board_card_checklist WHERE id=? AND board_id=? AND card_id=?').run(checklistItem[4],board.id,card.id); if(!result.changes)return fail(res,404,'Item não encontrado.');
        addBoardCardActivity(board.id,card.id,user.id,'checklist','removeu um item da checklist'); return send(res,200,{ok:true});
      }
      if(resource==='attachments'&&method==='POST'){
        const attachmentId=id(),stamp=now();
        if(String(req.headers['content-type']||'').includes('application/json')){
          const body=await jsonBody(req);let parsed;try{parsed=new URL(safeText(body.url,1500));}catch{return fail(res,400,'Informe um link válido.');}
          if(!['http:','https:'].includes(parsed.protocol))return fail(res,400,'O link deve começar com http:// ou https://.');
          const name=safeText(body.name,180)||parsed.hostname;
          db.prepare('INSERT INTO board_card_attachments (id,board_id,card_id,url,original_name,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(attachmentId,board.id,card.id,parsed.href,name,user.id,stamp);
          addBoardCardActivity(board.id,card.id,user.id,'link',`adicionou o link ${name}`);
          return send(res,201,{attachment:{id:attachmentId,url:parsed.href,href:parsed.href,originalName:name,mimeType:'',size:0,createdAt:stamp,userName:user.name}});
        }
        const bytes=await readBody(req,12*1024*1024); if(!bytes.length)return fail(res,400,'Selecione um arquivo.');
        const original=safeText(url.searchParams.get('name')||'anexo',180).replace(/[\\/:*?"<>|]/g,'_');
        const ext=extname(original).toLowerCase(); const mimeToExt={'image/png':['.png'],'image/jpeg':['.jpg','.jpeg'],'image/webp':['.webp'],'application/pdf':['.pdf'],'video/mp4':['.mp4'],'text/plain':['.txt'],'application/zip':['.zip']};
        if(!mimeToExt[req.headers['content-type']]?.includes(ext))return fail(res,415,'Formato não permitido. Use imagem, PDF, vídeo MP4, TXT ou ZIP.');
        const filename=`${attachmentId}${ext}`;writeFileSync(join(uploadDir,filename),bytes,{flag:'wx'});
        db.prepare('INSERT INTO board_card_attachments (id,board_id,card_id,filename,original_name,mime_type,size,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(attachmentId,board.id,card.id,filename,original,req.headers['content-type'],bytes.length,user.id,stamp);
        addBoardCardActivity(board.id,card.id,user.id,'attachment',`anexou ${original}`);
        return send(res,201,{attachment:{id:attachmentId,href:`/api/board-attachments/${attachmentId}`,originalName:original,mimeType:req.headers['content-type'],size:bytes.length,createdAt:stamp,userName:user.name}});
      }
      const attachmentMatch=boardCardResource[4]&&resource==='attachments'?boardCardResource:null;
      if(resource==='attachments'&&attachmentMatch&&method==='DELETE'){
        const attachment=db.prepare('SELECT * FROM board_card_attachments WHERE id=? AND board_id=? AND card_id=?').get(attachmentMatch[4],board.id,card.id); if(!attachment)return fail(res,404,'Anexo não encontrado.');
        if(attachment.filename){const file=join(uploadDir,attachment.filename);if(existsSync(file))unlinkSync(file);}
        db.prepare('DELETE FROM board_card_attachments WHERE id=?').run(attachment.id);addBoardCardActivity(board.id,card.id,user.id,'attachment',`removeu ${attachment.original_name}`);return send(res,200,{ok:true});
      }
      if(method==='GET'){
        if(resource==='attachments'){
          const row=db.prepare('SELECT * FROM board_card_attachments WHERE board_id=? AND card_id=? ORDER BY created_at').all(board.id,card.id);
          return send(res,200,{attachments:row.map(a=>({id:a.id,url:a.url,href:a.url||`/api/board-attachments/${a.id}`,originalName:a.original_name,mimeType:a.mime_type,size:a.size,createdAt:a.created_at}))});
        }
      }
    }
    const boardAttachment=path.match(/^\/api\/board-attachments\/([a-f0-9]+)$/);
    if(boardAttachment&&method==='GET'){
      if(!requirePermission(req,res,'boards.read'))return;
      const attachment=db.prepare('SELECT * FROM board_card_attachments WHERE id=?').get(boardAttachment[1]); if(!attachment||!attachment.filename)return fail(res,404,'Arquivo não encontrado.');
      const file=join(uploadDir,attachment.filename);if(!existsSync(file))return fail(res,404,'Arquivo não encontrado.');
      res.writeHead(200,{'content-type':attachment.mime_type,'content-length':attachment.size,'cache-control':'private, max-age=300','content-disposition':`inline; filename="${attachment.original_name.replace(/"/g,'')}"`});return createReadStream(file).pipe(res);
    }

    if (path === '/api/clients' && method === 'GET') {
      if (!requirePermission(req,res,'clients.read')) return;
      return send(res,200,{ clients: db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all().map(clientView) });
    }
    if (path === '/api/clients' && method === 'POST') {
      if (!requirePermission(req,res,'clients.write')) return;
      const input = validateClient(await jsonBody(req)); const clientId=id(); const stamp=now();
      db.prepare(`INSERT INTO clients (id,name,segment,description,audience,voice,offerings,objectives,content_pillars,brand_colors,posting_days,posting_time,auto_schedule_enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(clientId,input.name,input.segment,input.description,input.audience,input.voice,input.offerings,JSON.stringify(input.objectives),JSON.stringify(input.contentPillars),JSON.stringify(input.brandColors),JSON.stringify(input.postingDays),input.postingTime,input.autoScheduleEnabled?1:0,stamp,stamp);
      return send(res,201,{client:clientView(db.prepare('SELECT * FROM clients WHERE id=?').get(clientId))});
    }
    const clientNextSlot=path.match(/^\/api\/clients\/([a-f0-9]+)\/next-publication$/);
    if(clientNextSlot&&method==='GET'){
      if(!requirePermission(req,res,'clients.read'))return;const client=db.prepare('SELECT id FROM clients WHERE id=?').get(clientNextSlot[1]);if(!client)return fail(res,404,'Cliente não encontrado.');const slot=nextClientSlot(client.id);return send(res,200,{scheduledAt:slot?slot.toISOString():'',timeZone:SCHEDULE_ZONE});
    }
    if(path==='/api/client-schedules'&&method==='GET'){
      if(!requirePermission(req,res,'clients.read')||!requirePermission(req,res,'boards.read'))return;
      const schedules=db.prepare("SELECT c.id,c.title,c.client_id AS clientId,cl.name AS clientName,c.scheduled_at AS scheduledAt,c.schedule_mode AS scheduleMode,b.id AS boardId,b.name AS boardName,col.name AS columnName FROM board_cards c JOIN clients cl ON cl.id=c.client_id JOIN boards b ON b.id=c.board_id JOIN board_columns col ON col.id=c.column_id WHERE c.scheduled_at<>'' AND c.archived=0 AND b.archived=0 ORDER BY c.scheduled_at").all();
      return send(res,200,{schedules,timeZone:SCHEDULE_ZONE});
    }
    const clientMatch = path.match(/^\/api\/clients\/([a-f0-9]+)$/);
    if (clientMatch && method === 'GET') {
      if (!requirePermission(req,res,'clients.read')) return;
      const row=db.prepare('SELECT * FROM clients WHERE id=?').get(clientMatch[1]); return row ? send(res,200,{client:clientView(row)}) : fail(res,404,'Cliente não encontrado.');
    }
    if (clientMatch && method === 'PUT') {
      if (!requirePermission(req,res,'clients.write')) return;
      const row=db.prepare('SELECT * FROM clients WHERE id=?').get(clientMatch[1]); if (!row) return fail(res,404,'Cliente não encontrado.');
      const existing=clientView(row); const input=validateClient(await jsonBody(req),existing); const stamp=now();
      db.prepare(`UPDATE clients SET name=?,segment=?,description=?,audience=?,voice=?,offerings=?,objectives=?,content_pillars=?,brand_colors=?,posting_days=?,posting_time=?,auto_schedule_enabled=?,updated_at=? WHERE id=?`)
        .run(input.name,input.segment,input.description,input.audience,input.voice,input.offerings,JSON.stringify(input.objectives),JSON.stringify(input.contentPillars),JSON.stringify(input.brandColors),JSON.stringify(input.postingDays),input.postingTime,input.autoScheduleEnabled?1:0,stamp,row.id);
      db.prepare('UPDATE flows SET publish_days=?,publish_time=?,updated_at=? WHERE client_id=?').run(JSON.stringify(input.postingDays),input.postingTime,stamp,row.id);
      return send(res,200,{client:clientView(db.prepare('SELECT * FROM clients WHERE id=?').get(row.id))});
    }
    const assetMatch = path.match(/^\/api\/clients\/([a-f0-9]+)\/assets$/);
    if (assetMatch && method === 'POST') {
      if (!requirePermission(req,res,'assets.write')) return;
      const client=db.prepare('SELECT id FROM clients WHERE id=?').get(assetMatch[1]); if (!client) return fail(res,404,'Cliente não encontrado.');
      const bytes=await readBody(req,8*1024*1024); if (!bytes.length) return fail(res,400,'Arquivo vazio.');
      const original=safeText(url.searchParams.get('name') || 'referencia',180).replace(/[\\/:*?"<>|]/g,'_'); const ext=extname(original).toLowerCase(); const mime=mimeByExt[ext];
      if (!mime || req.headers['content-type'] !== mime) return fail(res,415,'Use imagem PNG, JPG ou WebP, ou PDF.');
      const assetId=id(); const stored=`${assetId}${ext}`; writeFileSync(join(uploadDir,stored),bytes,{flag:'wx'});
      const category=assetCategories.includes(url.searchParams.get('category'))?url.searchParams.get('category'):'reference';
      db.prepare('INSERT INTO assets (id,client_id,filename,original_name,mime_type,size,category,created_at) VALUES (?,?,?,?,?,?,?,?)').run(assetId,client.id,stored,original,mime,bytes.length,category,now());
      if(category==='profile')db.prepare('UPDATE clients SET profile_asset_id=?,updated_at=? WHERE id=?').run(assetId,now(),client.id);
      return send(res,201,{asset:{id:assetId,originalName:original,mimeType:mime,size:bytes.length,category}});
    }
    const assetGet=path.match(/^\/api\/assets\/([a-f0-9]+)$/);
    if (assetGet && method === 'GET') {
      if (!requirePermission(req,res,'clients.read')) return;
      const asset=db.prepare('SELECT * FROM assets WHERE id=?').get(assetGet[1]); if (!asset) return fail(res,404,'Arquivo não encontrado.');
      const file=join(uploadDir,asset.filename); if (!existsSync(file)) return fail(res,404,'Arquivo não encontrado.');
      res.writeHead(200,{'content-type':asset.mime_type,'content-length':asset.size,'cache-control':'private, max-age=300','content-disposition':`inline; filename="${asset.original_name.replace(/"/g,'')}"`}); return createReadStream(file).pipe(res);
    }
    if (path === '/api/flows' && method === 'GET') {
      if (!requirePermission(req,res,'flows.read')) return;
      return send(res,200,{flows:db.prepare('SELECT * FROM flows ORDER BY updated_at DESC').all().map(flowView)});
    }
    if (path === '/api/flows' && method === 'POST') {
      if (!requirePermission(req,res,'flows.write')) return;
      const body=await jsonBody(req); const client=db.prepare('SELECT id FROM clients WHERE id=?').get(body.clientId);
      if (!client) return fail(res,404,'Cliente não encontrado.');
      if (db.prepare('SELECT id FROM flows WHERE client_id=?').get(client.id)) return fail(res,409,'Este cliente já tem um fluxo.');
      const flowId=id(); const stamp=now();
      const briefing='Padrão editorial da agência: pauta fiel ao perfil e às referências; varie objetivos e pilares sem repetir assuntos recentes. Arte com manchete curta e apoio opcional, sem CTA, hashtags, nome da empresa ou segmento. CTA conversacional na legenda e exatamente 5 hashtags minúsculas, separadas por três linhas com um ponto. Legenda com gancho, 2 ou 3 parágrafos didáticos e CTA final. Use objetos ou metáforas pertinentes; não use pessoas por padrão. Aprenda identidade, tipografia, composição e formas pelas referências.';
      const image='Siga as referências como sistema de identidade visual: paleta, tipografia, composição, formas e hierarquia. Use assunto visual diretamente pertinente, sem pessoas por padrão nem objetos aleatórios. Deixe área limpa para o texto ser composto pela plataforma. A peça terá manchete curta, apoio opcional e logo original; nunca inclua CTA, hashtags, nome/segmento do cliente ou texto inventado.';
      const savedSchedule=db.prepare('SELECT posting_days,posting_time FROM clients WHERE id=?').get(client.id);const publishDays=JSON.parse(savedSchedule.posting_days||'[]');if(!publishDays.length)publishDays.push('terça','quinta','domingo');const publishTime=savedSchedule.posting_time||'09:00';
      db.prepare('INSERT INTO flows (id,client_id,generation_day,posts_per_cycle,publish_days,publish_time,briefing_instructions,briefing_asset_ids,image_instructions,image_asset_ids,created_at,updated_at) VALUES (?,? ,\'segunda\',3,?,?,?,\'[]\',?,\'[]\',?,?)').run(flowId,client.id,JSON.stringify(publishDays),publishTime,briefing,image,stamp,stamp);
      if(!JSON.parse(savedSchedule.posting_days||'[]').length)db.prepare('UPDATE clients SET posting_days=?,posting_time=?,updated_at=? WHERE id=?').run(JSON.stringify(publishDays),publishTime,stamp,client.id);
      return send(res,201,{flow:flowView(db.prepare('SELECT * FROM flows WHERE id=?').get(flowId))});
    }
    const flowMatch=path.match(/^\/api\/flows\/([a-f0-9]+)$/);
    if (flowMatch && method === 'GET') {
      if (!requirePermission(req,res,'flows.read')) return;
      const row=db.prepare('SELECT * FROM flows WHERE id=?').get(flowMatch[1]); return row?send(res,200,{flow:flowView(row)}):fail(res,404,'Fluxo não encontrado.');
    }
    const flowRunsMatch=path.match(/^\/api\/flows\/([a-f0-9]+)\/runs$/);
    if (flowRunsMatch && method === 'GET') {
      if (!requirePermission(req,res,'flows.read')) return;
      const flow=db.prepare('SELECT id FROM flows WHERE id=?').get(flowRunsMatch[1]); if(!flow)return fail(res,404,'Fluxo não encontrado.');
      return send(res,200,{runs:db.prepare('SELECT flow_runs.*,clients.name AS client_name FROM flow_runs JOIN flows ON flows.id=flow_runs.flow_id JOIN clients ON clients.id=flows.client_id WHERE flow_id=? ORDER BY created_at DESC LIMIT 12').all(flow.id).map(flowRunView)});
    }
    if(path==='/api/manual-approvals'&&method==='POST'){
      if(!requirePermission(req,res,'clients.read')||!requirePermission(req,res,'flows.write'))return;
      const clientId=safeText(url.searchParams.get('clientId'),64);const client=db.prepare('SELECT id FROM clients WHERE id=?').get(clientId);if(!client)return fail(res,404,'Cliente não encontrado.');
      const bytes=await readBody(req,8*1024*1024);if(!bytes.length)return fail(res,400,'Selecione uma arte.');const mime=req.headers['content-type'];const ext=({ 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp' })[mime];if(!ext)return fail(res,415,'Use uma imagem PNG, JPG ou WebP.');
      const postId=id();const filename=`${postId}${ext}`;writeFileSync(join(uploadDir,filename),bytes,{flag:'wx'});const name=safeText(url.searchParams.get('name')||'arte-manual',180);const caption=safeText(url.searchParams.get('caption')||'',5000);db.prepare('INSERT INTO manual_posts (id,client_id,image_filename,original_name,mime_type,size,caption_text,created_at) VALUES (?,?,?,?,?,?,?,?)').run(postId,client.id,filename,name,mime,bytes.length,caption,now());return send(res,201,{post:{id:postId}});
    }
    if(path==='/api/manual-approvals'&&method==='GET'){
      if(!requirePermission(req,res,'clients.read'))return;const status=url.searchParams.get('status')||'pending_approval';if(!['pending_approval','approved','rejected'].includes(status))return fail(res,400,'Status inválido.');const posts=db.prepare('SELECT manual_posts.*,clients.name AS client_name FROM manual_posts JOIN clients ON clients.id=manual_posts.client_id WHERE manual_posts.status=? ORDER BY manual_posts.created_at DESC').all(status).map(row=>({id:row.id,clientId:row.client_id,clientName:row.client_name,imageUrl:`/api/manual-approvals/${row.id}/image`,caption:row.caption_text,status:row.status,rejectionNote:row.rejection_note,createdAt:row.created_at,approvedAt:row.approved_at}));return send(res,200,{posts});
    }
    const manualImage=path.match(/^\/api\/manual-approvals\/([a-f0-9]+)\/image$/);if(manualImage&&method==='GET'){if(!requirePermission(req,res,'clients.read'))return;const row=db.prepare('SELECT * FROM manual_posts WHERE id=?').get(manualImage[1]);if(!row)return fail(res,404,'Arte não encontrada.');const file=join(uploadDir,row.image_filename);if(!existsSync(file))return fail(res,404,'Arte não encontrada.');res.writeHead(200,{'content-type':row.mime_type,'content-length':row.size,'cache-control':'private, max-age=300'});return createReadStream(file).pipe(res);}
    const manualAction=path.match(/^\/api\/manual-approvals\/([a-f0-9]+)\/(approve|reject)$/);if(manualAction&&method==='POST'){if(!requirePermission(req,res,'flows.write'))return;const row=db.prepare('SELECT * FROM manual_posts WHERE id=?').get(manualAction[1]);if(!row)return fail(res,404,'Arte não encontrada.');if(row.status!=='pending_approval')return fail(res,409,'Esta arte já foi revisada.');if(manualAction[2]==='approve')db.prepare("UPDATE manual_posts SET status='approved',approved_at=? WHERE id=?").run(now(),row.id);else db.prepare("UPDATE manual_posts SET status='rejected',rejection_note=? WHERE id=?").run(safeText((await jsonBody(req)).note||'',1000),row.id);return send(res,200,{ok:true});}
    if(path==='/api/approvals'&&method==='GET'){
      if(!requirePermission(req,res,'flows.read'))return;
      const requestedStatus=new URL(req.url,'http://localhost').searchParams.get('status')||'pending_approval';
      const status=['approved','rejected'].includes(requestedStatus)?requestedStatus:'pending_approval';
      const order=status==='approved'?'flow_runs.approved_at DESC':'flow_runs.created_at ASC';
      const rows=db.prepare(`SELECT flow_runs.*,clients.id AS client_id,clients.name AS client_name FROM flow_runs JOIN flows ON flows.id=flow_runs.flow_id JOIN clients ON clients.id=flows.client_id WHERE flow_runs.status=? ORDER BY ${order} LIMIT 100`).all(status);
      return send(res,200,{approvals:rows.map(row=>{const current=flowRunView(row);const root=row.parent_run_id||row.id;current.versions=db.prepare("SELECT flow_runs.*,clients.name AS client_name FROM flow_runs JOIN flows ON flows.id=flow_runs.flow_id JOIN clients ON clients.id=flows.client_id WHERE flow_runs.id=? OR flow_runs.parent_run_id=? ORDER BY flow_runs.version_number").all(root,root).map(flowRunView);return current;})});
    }
    const reviseAction=path.match(/^\/api\/flow-runs\/([a-f0-9]+)\/revise$/);
    if(reviseAction&&method==='POST'){
      if(!requirePermission(req,res,'flows.write'))return;
      const current=db.prepare("SELECT flow_runs.*,flows.client_id FROM flow_runs JOIN flows ON flows.id=flow_runs.flow_id WHERE flow_runs.id=?").get(reviseAction[1]);
      if(!current)return fail(res,404,'Conteúdo não encontrado.');if(current.status!=='pending_approval')return fail(res,409,'Este conteúdo não está mais aguardando aprovação.');
      const note=safeText((await jsonBody(req)).note,3000);if(!note)return fail(res,400,'Descreva o ajuste que a IA deve fazer.');if(!openAiConfigured())return fail(res,409,'Configure a chave OpenAI para solicitar uma nova versão.');
      const flow=flowView(db.prepare('SELECT * FROM flows WHERE id=?').get(current.flow_id));const root=current.parent_run_id||current.id;const runId=id();const nextVersion=current.version_number+1;const stamp=now();
      db.prepare("UPDATE flow_runs SET status='superseded' WHERE id=? AND status='pending_approval'").run(current.id);
      db.prepare("INSERT INTO flow_runs (id,flow_id,run_type,status,stage,parent_run_id,revision_note,version_number,created_at) VALUES (?,?, 'full','running','briefing',?,?,?,?)").run(runId,current.flow_id,root,note,nextVersion,stamp);
      startFlowGeneration(flow,runId,note);
      return send(res,202,{run:flowRunView(db.prepare('SELECT * FROM flow_runs WHERE id=?').get(runId))});
    }
    const approvalAction=path.match(/^\/api\/flow-runs\/([a-f0-9]+)\/approve$/);
    if(approvalAction&&method==='POST'){
      if(!requirePermission(req,res,'flows.write'))return;
      const row=db.prepare("SELECT flow_runs.*,clients.id AS client_id,clients.name AS client_name,clients.posting_days,clients.posting_time,clients.auto_schedule_enabled FROM flow_runs JOIN flows ON flows.id=flow_runs.flow_id JOIN clients ON clients.id=flows.client_id WHERE flow_runs.id=?").get(approvalAction[1]);
      if(!row)return fail(res,404,'Conteúdo não encontrado.');if(row.status!=='pending_approval')return fail(res,409,'Este conteúdo não está mais aguardando aprovação.');
      const body=await jsonBody(req);let scheduled=null;
      if(body.mode==='manual'){
        scheduled=new Date(body.scheduledAt||'');if(!Number.isFinite(scheduled.getTime())||scheduled<=new Date())return fail(res,400,'Escolha uma data e um horário futuros.');
        if(isScheduleSlotOccupied(scheduled))return fail(res,409,'Esse horário já está ocupado por outro conteúdo. Escolha outro horário.');
      }else{
        scheduled=nextClientSlot(row.client_id);if(!scheduled)return fail(res,409,'Ative o agendamento automático e escolha ao menos um dia no perfil deste cliente, ou selecione agendamento manual.');
      }
      const stamp=now();db.prepare("UPDATE flow_runs SET status='approved',scheduled_at=?,approved_at=? WHERE id=? AND status='pending_approval'").run(scheduled.toISOString(),stamp,row.id);
      return send(res,200,{run:flowRunView(db.prepare('SELECT flow_runs.*,clients.name AS client_name FROM flow_runs JOIN flows ON flows.id=flow_runs.flow_id JOIN clients ON clients.id=flows.client_id WHERE flow_runs.id=?').get(row.id))});
    }
    const rejectionAction=path.match(/^\/api\/flow-runs\/([a-f0-9]+)\/reject$/);if(rejectionAction&&method==='POST'){if(!requirePermission(req,res,'flows.write'))return;const row=db.prepare("SELECT id,status FROM flow_runs WHERE id=?").get(rejectionAction[1]);if(!row)return fail(res,404,'Conteúdo não encontrado.');if(row.status!=='pending_approval')return fail(res,409,'Este conteúdo não está mais aguardando aprovação.');db.prepare("UPDATE flow_runs SET status='rejected' WHERE id=?").run(row.id);return send(res,200,{ok:true});}
    const flowTestMatch=path.match(/^\/api\/flows\/([a-f0-9]+)\/test$/);
    if (flowTestMatch && method === 'POST') {
      if (!requirePermission(req,res,'flows.write')) return;
      const flowRow=db.prepare('SELECT * FROM flows WHERE id=?').get(flowTestMatch[1]); if(!flowRow)return fail(res,404,'Fluxo não encontrado.');
      const type=safeText((await jsonBody(req)).type,20); if(!['briefing','image','full'].includes(type))return fail(res,400,'Escolha um teste de briefing, arte ou fluxo completo.');
      if(!openAiConfigured())return fail(res,409,'Configure uma chave OpenAI para habilitar os testes.');
      const flow=flowView(flowRow); const runId=id(); const stamp=now();
      db.prepare('INSERT INTO flow_runs (id,flow_id,run_type,status,stage,created_at) VALUES (?,?,?,\'running\',?,?)').run(runId,flow.id,type,type==='full'?'briefing':'',stamp);
      if(type==='full'){
        startFlowGeneration(flow,runId);
        return send(res,202,{run:flowRunView(db.prepare('SELECT * FROM flow_runs WHERE id=?').get(runId))});
      }
      try {
        let briefingText=''; let imageFilename=''; let creativeSpec=imageCreativeSpec(flow);
        let caption='';
        if(type==='briefing'){const briefing=await generateBriefing(flow);briefingText=briefing.text;caption=briefing.caption;creativeSpec=briefing.spec;}
        if(type==='image')imageFilename=await generateImage(flow,creativeSpec);
        const status='preview';
        db.prepare('UPDATE flow_runs SET status=?,briefing_text=?,caption_text=?,creative_spec=?,image_filename=? WHERE id=?').run(status,briefingText,caption,JSON.stringify(creativeSpec),imageFilename,runId);
        return send(res,200,{run:flowRunView(db.prepare('SELECT * FROM flow_runs WHERE id=?').get(runId))});
      } catch(error) {
        const message=safeText(error.message,1000)||'Falha na integração OpenAI.';
        db.prepare('UPDATE flow_runs SET status=\'failed\',error=? WHERE id=?').run(message,runId);
        return fail(res,502,message);
      }
    }
    const flowRunImageMatch=path.match(/^\/api\/flow-runs\/([a-f0-9]+)\/image$/);
    if(flowRunImageMatch&&method==='GET'){
      if(!requirePermission(req,res,'flows.read'))return;
      const run=db.prepare('SELECT image_filename FROM flow_runs WHERE id=?').get(flowRunImageMatch[1]);if(!run?.image_filename)return fail(res,404,'Imagem de teste não encontrada.');
      const file=join(generationDir,run.image_filename);if(!existsSync(file))return fail(res,404,'Imagem de teste não encontrada.');
      res.writeHead(200,{'content-type':extname(file)==='.svg'?'image/svg+xml':'image/png','cache-control':'private, max-age=300'});return createReadStream(file).pipe(res);
    }
    if (flowMatch && method === 'PUT') {
      if (!requirePermission(req,res,'flows.write')) return;
      const row=db.prepare('SELECT * FROM flows WHERE id=?').get(flowMatch[1]); if (!row) return fail(res,404,'Fluxo não encontrado.');
      const config=validateFlow(await jsonBody(req),row,row.client_id); const stamp=now();
      db.prepare('UPDATE flows SET generation_day=?,posts_per_cycle=?,publish_days=?,publish_time=?,briefing_instructions=?,briefing_asset_ids=?,image_instructions=?,image_asset_ids=?,updated_at=? WHERE id=?')
        .run(config.generationDay,config.postsPerCycle,JSON.stringify(config.publishDays),config.publishTime,config.briefingInstructions,JSON.stringify(config.briefingAssetIds),config.imageInstructions,JSON.stringify(config.imageAssetIds),stamp,row.id);
      db.prepare('UPDATE clients SET posting_days=?,posting_time=?,updated_at=? WHERE id=?').run(JSON.stringify(config.publishDays),config.publishTime,stamp,row.client_id);
      return send(res,200,{flow:flowView(db.prepare('SELECT * FROM flows WHERE id=?').get(row.id))});
    }
    if (path === '/api/users' && method === 'GET') {
      if (!requirePermission(req,res,'users.manage')) return;
      return send(res,200,{users:db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(userView)});
    }
    if (path === '/api/users' && method === 'POST') {
      if (!requirePermission(req,res,'users.create')) return;
      const body=await jsonBody(req); const name=safeText(body.name,120); const email=safeText(body.email,180).toLowerCase(); const password=String(body.password||''); const role=db.prepare('SELECT id FROM roles WHERE id=?').get(body.roleId);
      if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length<12 || !role) return fail(res,400,'Confira nome, e-mail, senha (12 caracteres ou mais) e cargo.');
      const userId=id(); try { db.prepare('INSERT INTO users (id,name,email,password_hash,role_id,active,created_at) VALUES (?,?,?,?,?,1,?)').run(userId,name,email,hashPassword(password),role.id,now()); } catch { return fail(res,409,'Já existe um usuário com este e-mail.'); }
      return send(res,201,{user:userView(db.prepare('SELECT * FROM users WHERE id=?').get(userId))});
    }
    if (path === '/api/role-options' && method === 'GET') {
      if (!requirePermission(req,res,'users.create')) return;
      return send(res,200,{roles:db.prepare('SELECT id,name FROM roles ORDER BY system DESC,name').all()});
    }
    const userMatch=path.match(/^\/api\/users\/([a-f0-9]+)$/);
    if (userMatch && method==='DELETE') {
      const actor=requirePermission(req,res,'users.delete'); if (!actor) return;
      const target=db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]); if (!target) return fail(res,404,'Usuário não encontrado.');
      if (target.id===actor.id) return fail(res,400,'Você não pode excluir o próprio acesso.');
      const targetRole=db.prepare('SELECT permissions FROM roles WHERE id=?').get(target.role_id);
      if (targetRole && JSON.parse(targetRole.permissions).includes('roles.manage') && target.active) {
        const admins=db.prepare('SELECT u.id,r.permissions FROM users u JOIN roles r ON r.id=u.role_id WHERE u.active=1').all().filter(u=>JSON.parse(u.permissions).includes('roles.manage'));
        if (admins.length<=1) return fail(res,409,'Mantenha pelo menos um administrador ativo.');
      }
      db.prepare('DELETE FROM users WHERE id=?').run(target.id);
      return send(res,200,{ok:true});
    }
    if (userMatch && method==='PUT') {
      const actor=requirePermission(req,res,'users.edit'); if (!actor) return;
      const current=db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]); if (!current) return fail(res,404,'Usuário não encontrado.');
      const body=await jsonBody(req); const name=safeText(body.name ?? current.name,120); const email=safeText(body.email ?? current.email,180).toLowerCase(); const roleId=body.roleId ?? current.role_id; const active=body.active === undefined ? current.active : (body.active ? 1 : 0); const role=db.prepare('SELECT id FROM roles WHERE id=?').get(roleId);
      if (!name || !/^\S+@\S+\.\S+$/.test(email) || !role) return fail(res,400,'Confira nome, e-mail e cargo.');
      if (current.id===actor.id && !active) return fail(res,400,'Você não pode desativar seu próprio acesso.');
      const password=String(body.password||''); if (password && password.length<12) return fail(res,400,'A senha precisa ter pelo menos 12 caracteres.');
      try { db.prepare('UPDATE users SET name=?,email=?,role_id=?,active=?,password_hash=COALESCE(?,password_hash) WHERE id=?').run(name,email,role.id,active,password?hashPassword(password):null,current.id); } catch { return fail(res,409,'Já existe um usuário com este e-mail.'); }
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id);
      return send(res,200,{user:userView(db.prepare('SELECT * FROM users WHERE id=?').get(current.id))});
    }
    if (path === '/api/roles' && method === 'GET') {
      if (!requirePermission(req,res,'roles.view')) return;
      return send(res,200,{roles:db.prepare('SELECT id,name,description,color,permissions,system,created_at AS createdAt FROM roles ORDER BY system DESC,name').all().map(r=>({...r,permissions:JSON.parse(r.permissions),system:Boolean(r.system)}))});
    }
    if (path === '/api/roles' && method === 'POST') {
      if (!requirePermission(req,res,'roles.create')) return;
      const body=await jsonBody(req); const name=safeText(body.name,80); const description=''; const permissions=permissionsForStorage(body.permissions); const palette=['#4946f5','#bba4ff','#27ae73','#ff6b8a','#ff9f43','#22a6b3','#d8ff36','#1d2825']; const color=/^#[0-9a-fA-F]{6}$/.test(body.color||'')?body.color:palette[db.prepare('SELECT COUNT(*) AS n FROM roles WHERE system=0').get().n%palette.length];
      if (!name) return fail(res,400,'Informe o nome do cargo.');
      const roleId=id(); try { db.prepare('INSERT INTO roles (id,name,description,permissions,system,created_at,color) VALUES (?,?,?,?,0,?,?)').run(roleId,name,description,JSON.stringify(permissions),now(),color); } catch { return fail(res,409,'Já existe um cargo com esse nome.'); }
      return send(res,201,{role:{id:roleId,name,description,color,permissions,system:false}});
    }
    const roleMatch=path.match(/^\/api\/roles\/([a-z0-9-]+)$/i);
    if (roleMatch && method==='PUT') {
      if (!requirePermission(req,res,'roles.edit')) return;
      const role=db.prepare('SELECT * FROM roles WHERE id=?').get(roleMatch[1]); if (!role) return fail(res,404,'Cargo não encontrado.');
      const body=await jsonBody(req);const color=/^#[0-9a-fA-F]{6}$/.test(body.color||'')?body.color:role.color;if(role.system){db.prepare('UPDATE roles SET color=? WHERE id=?').run(color,role.id);return send(res,200,{role:{id:role.id,name:role.name,description:role.description,color,permissions:JSON.parse(role.permissions),system:true}});}const name=safeText(body.name ?? role.name,80); const description=''; const permissions=permissionsForStorage(body.permissions ?? JSON.parse(role.permissions));
      if (!name) return fail(res,400,'Informe o nome do cargo.');
      try { db.prepare('UPDATE roles SET name=?,description=?,permissions=?,color=? WHERE id=?').run(name,description,JSON.stringify(permissions),color,role.id); } catch { return fail(res,409,'Já existe um cargo com esse nome.'); }
      return send(res,200,{role:{id:role.id,name,description,color,permissions,system:false}});
    }
    if (roleMatch && method==='DELETE') {
      if (!requirePermission(req,res,'roles.delete')) return;
      const role=db.prepare('SELECT * FROM roles WHERE id=?').get(roleMatch[1]); if (!role) return fail(res,404,'Cargo não encontrado.'); if (role.system) return fail(res,400,'O cargo Administrador do sistema não pode ser excluído.');
      if (db.prepare('SELECT 1 FROM users WHERE role_id=? LIMIT 1').get(role.id)) return fail(res,409,'Reatribua os usuários antes de excluir este cargo.');
      db.prepare('DELETE FROM roles WHERE id=?').run(role.id); return send(res,200,{ok:true});
    }
    if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/')) return handleStatic(path,req,res);
    return fail(res,404,'Não encontrado.');
  } catch (error) { return fail(res,error.status || 500,error.status ? error.message : 'Ocorreu um erro ao processar a solicitação.'); }
}

const server=createServer((req,res)=>{
  // The Codex preview keeps its browser origin on port 3001 while the refreshed
  // API runs on 3002. Allow that exact local origin so the existing browser
  // session can use the current server without a second login.
  const origin=req.headers.origin;
  if(origin==='http://127.0.0.1:3001'){
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Client-Id');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Vary','Origin');
  }
  if(req.method==='OPTIONS') { res.writeHead(204); return res.end(); }
  res.once('finish',()=>{if(req.url?.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(req.method)&&res.statusCode<400){try{const actor=sessionFor(req),stamp=now(),clientId=safeText(req.headers['x-client-id']||'',80);db.prepare('UPDATE workspace_state SET revision=revision+1,actor_id=?,changed_at=? WHERE id=1').run(actor?.id||'',stamp);db.prepare('INSERT INTO workspace_changes (revision,actor_id,client_id,changed_at) SELECT revision,?,?,? FROM workspace_state WHERE id=1').run(actor?.id||'',clientId,stamp);db.prepare('DELETE FROM workspace_changes WHERE revision<(SELECT MAX(revision)-500 FROM workspace_changes)').run();}catch(error){console.error('[Workspace revision]',error.message);}}});
  void route(req,res);
});
server.on('error', (err) => { console.error('[Server error]', err); });
const port=Number(process.env.PORT)||3000;
const host=process.env.HOST||'0.0.0.0';
if (process.env.NODE_ENV !== 'test') server.listen(port,host,()=>console.log(`3A Workspace disponível em http://${host}:${port}`));
function shutdown(){ server.close(()=>{ try { db.close(); } catch {} process.exit(0); }); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
process.on('uncaughtException', (err) => { console.error('[Server uncaughtException]', err); });
process.on('unhandledRejection', (reason) => { console.error('[Server unhandledRejection]', reason); });
export { db, server };
