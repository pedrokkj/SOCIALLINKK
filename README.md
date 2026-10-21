# 3A Workspace

Base inicial da plataforma interna da agência 3A. Inclui cadastro de clientes e referências, gerenciamento de acessos, fluxos de conteúdo com IA e uma fila local de aprovação. A publicação ainda depende da integração com a Meta.

## Executar localmente

Requer Node.js 22.5 ou superior (recomendado: Node.js 24). Não há dependências externas para instalar.

```powershell
pnpm start
```

Abra [http://127.0.0.1:3000](http://127.0.0.1:3000). Na primeira visita, crie o usuário administrador. As senhas precisam ter no mínimo 12 caracteres.

O servidor escuta apenas em `127.0.0.1` por padrão. Para desenvolvimento, use `pnpm dev`. A configuração `HOST=0.0.0.0` pode tornar o serviço acessível pela rede local e deve ser usada somente quando a rede e o computador estiverem preparados para isso.

## O que funciona nesta etapa

- Cadastro, consulta e edição de perfis de clientes com segmento, contexto da marca, público, tom de voz, produtos e serviços, objetivos, pilares e paleta de cores.
- Upload e visualização de referências organizadas em logotipos, posts anteriores do cliente, guias de marca, referências visuais e outros materiais, em PNG, JPG, WebP e PDF. Arquivos e metadados ficam associados ao cliente.
- Configuração inicial de administrador, login, alteração de cargo e status de acesso, e criação de usuários.
- Cargos personalizados com permissões para consultar/editar clientes, adicionar referências, gerenciar usuários/cargos e consultar/configurar fluxos.
- Um fluxo padrão por cliente, com etapas fixas conectadas: agenda de criação, briefing, criação de arte, aprovação humana e agenda de publicação. O agendamento da criação fica separado dos dias e horários de publicação, definidos apenas na etapa final.
- Upload de referências no perfil do cliente ou dentro das etapas de briefing e criação de arte. Os arquivos novos podem ser vinculados à etapa no momento do envio.
- Prévia local do contexto preparado para briefing e arte. A prévia mostra os dados selecionados e não chama uma IA.
- Um botão “Testar fluxo” acompanha a criação do briefing, a geração da arte e a entrada na fila de aprovação. As chamadas de IA podem gerar cobrança. A chave fica no arquivo local ignorado pelo Git; a aplicação não a retorna ao navegador.
- O briefing exige uma resposta estruturada em JSON com manchete, apoio, CTA, conceito visual, elementos pertinentes e legenda. A etapa seguinte recebe cada campo separadamente.
- A arte usa GPT Image 2.5 Sunburst em alta qualidade. Posts e guias selecionados orientam o estilo; seus objetos não devem substituir o assunto do briefing. O logo original selecionado e as frases exatas são compostos sobre a imagem pelo servidor, sem pedir ao modelo que redesenhe marca ou texto.
- As artes compostas ficam em SVG local com imagem de fundo incorporada. Isso preserva o texto e o logo exatamente como foram definidos, inclusive na fila de aprovação e no histórico de versões.
- A fila de aprovação mostra a arte e a legenda; o briefing fica acessível em um controle recolhido. É possível pedir ajustes à IA e consultar as versões anteriores. Ao aprovar, o sistema reserva localmente o próximo dia e horário configurado do cliente. A publicação depende da integração Meta.
- Exclusão de usuários com proteção contra apagar o próprio acesso ou o último administrador.
- Banco SQLite persistente em `data/3a-workspace.sqlite`; arquivos ficam em `data/uploads/`.
- Teste de integração para persistência, cadastro, upload e autorização por cargo.

## Testes

```powershell
pnpm test
```

## Decisões de dados

Os perfis guardam os dados editoriais estruturados e as referências como arquivos separados com metadados (cliente, tipo, nome, formato e tamanho). O SQLite mantém relacionamentos entre clientes, arquivos, pessoas e cargos. Cada execução do fluxo persiste o briefing e a especificação da composição separadamente, para que as versões de aprovação mantenham as instruções exatas usadas em cada arte.

## Próximas etapas sugeridas

1. Revisar e completar os campos do cadastro e as instruções dos fluxos com a equipe.
2. Incluir busca e filtros de referências e uma prévia maior das artes do cliente.
3. Adicionar trilha de auditoria, recuperação de acesso e política de sessão antes de hospedar para toda a equipe.
4. Integrar a publicação e o agendamento pela Meta. A publicação ainda não executa e exigirá configuração do app e permissões da Meta.

## Escopo e implantação

Esta versão é um protótipo funcional local. Sessões ficam em memória e terminam quando o servidor reinicia. Ainda não há HTTPS, recuperação de senha, auditoria ou backup automatizado. Antes de publicar num domínio interno, precisamos definir hospedagem, HTTPS, backup e acesso multiusuário.
