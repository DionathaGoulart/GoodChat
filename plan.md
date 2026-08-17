# GoodChat — Plano de Implementação por Fases

Plano operacional derivado de `.harness/prd.md` (fonte de verdade funcional) e `.harness/styleguide.md` (fonte de verdade visual). Desenhado para execução com **contexto limpo entre fases**: cada fase é autocontida, declara exatamente o que ler ao começar, e termina gravando um handoff aqui dentro.

---

## Como usar (protocolo por fase)

1. Usuário diz: **"vai pra fase N"** (em sessão limpa, após `/clear`).
2. Agente lê, nesta ordem: (a) este `plan.md` inteiro — em especial o **Estado global** e os **handoffs das fases anteriores**; (b) os arquivos listados em **"Ler antes"** da fase N. Nada além disso — não reler o projeto inteiro.
3. Executa as tarefas da fase. Commits pequenos e escopados (`feat(auth): ...`).
4. Ao concluir: roda os critérios de aceite, **atualiza o Estado global e o bloco "Handoff" da fase** (o que foi criado, decisões, desvios, pendências), e para. Usuário faz `/clear` e chama a próxima.
5. Bloqueio/ambiguidade: checar `.harness/prd.md` §10 (Open Questions) primeiro; se não coberto, perguntar ao usuário. Não inventar escopo (não-goals no PRD §1.4).

### Convenções globais (valem em toda fase)

- TypeScript estrito em tudo; sem `any` implícito. Zod nas boundaries de API.
- Backend local **sempre na porta 8000** (`wrangler dev --port 8000`); frontend Vite aponta para `http://localhost:8000`.
- CORS aberto (`origin: *`) nos endpoints REST.
- Segurança: escapar todo conteúdo de usuário; validar tipo/tamanho de arquivo server-side; cookie de sessão exatamente `HttpOnly; Secure; SameSite=Strict; Path=/`.
- Ferramentas de movimento rápido (Agents SDK, Durable Objects WS Hibernation, daisyUI 5, lib de hash compatível com Workers): **verificar docs oficiais atuais antes de usar** — não confiar só em conhecimento de treino.
- Animações: só fade/slide com ease-out, sem spring/bounce/overshoot (styleguide §4-Motion).
- UI: nunca hardcodar cor/espaçamento — só tokens do tema (styleguide §7).
- Estrutura do repo: `/app` (frontend), `/worker` (backend), `/.harness` (docs, nunca deployado).

---

## Estado global

| Fase | Nome | Status |
|---|---|---|
| 1 | Scaffolding + tema | ✅ concluída |
| 2 | D1 + Auth | ✅ concluída |
| 3 | Usuários + conversas (REST) | ✅ concluída |
| 4 | Real-time core (DO + WebSocket) | ✅ concluída |
| 5 | Frontend do chat | ✅ concluída |
| 6 | Pipeline de mídia (B2) | ✅ concluída |
| 7 | Receipts, typing, emoji, stickers | ✅ concluída |
| 8 | PWA + push (stretch) | ✅ concluída |

MVP = fases 1–6 (emoji inline da fase 7 é trivial e pode antecipar). Definition of Done completa: `inicial.md` §2.4 espelhada nos critérios das fases.

---

## Fase 1 — Scaffolding + tema

**Objetivo:** monorepo funcional com `/app` e `/worker` rodando localmente, tema retro aplicado e visível.

**Ler antes:** `.harness/styleguide.md` (inteiro), `.harness/prd.md` §11 (stack) e §4.1–4.2 (arquitetura).

**Tarefas:**
1. Verificar docs atuais: comando de scaffold do Cloudflare Agents SDK (`npm create cloudflare` / template `agents`), passos de install Tailwind v4 + daisyUI 5 no Vite.
2. `/worker`: projeto Workers TS com Agents SDK/Durable Objects habilitado; `wrangler.jsonc` com bindings placeholder (D1, DO); `npm run dev` na porta 8000; rota `GET /api/health` respondendo.
3. `/app`: Vite + React + TS; Tailwind v4 + daisyUI 5 CSS-first.
4. Tema: criar `app/src/styles/palettes.css` e blocos `@plugin "daisyui/theme"` `goodchat-light`/`goodchat-dark` copiando os valores do styleguide §2 e §7 (receita pronta lá — radius 0, border 2px, `--shadow`, `--scanline-color`, `--frame-border`). Utilities: `retro-shadow(-sm)`, `retro-border`, `terminal-cursor` + blink, `terminal-scanline`, `btn-goodchat`/`btn-goodchat-outline` via tokens do `btn`. Fonte JetBrains Mono (`@fontsource` ou woff2 local), alias sans+mono.
5. Página demo temporária mostrando botão, card com `retro-shadow`, texto — prova visual do tema nos dois modos (toggle simples via `data-theme`).
6. `.env.example` em `/app` e `/worker` documentando todos os valores (D1 binding, B2 keys, cookie secret...). `.gitignore` adequado. `git init` + commit inicial se ainda não for repo.

**Critérios de aceite:** `wrangler dev` (8000) e Vite dev sobem sem erro; `/api/health` ok; demo renderiza com cara retro (cantos retos, sombra dura, JetBrains Mono) em light e dark; typecheck verde nos dois pacotes.

**Não fazer:** nenhuma feature de chat, auth ou schema ainda.

**Handoff (concluída 2026-08-17):**

- **Versões:** Vite 8.2 + React 19.2 + TS ~6.0 (app, template `react-ts`); tailwindcss 4.3.3 + `@tailwindcss/vite` + daisyui 5.7.17; worker: `agents` 0.20.1, wrangler 4.123, TS 7.0. Node 24.
- **Worker feito à mão** (sem template `agents-starter` — ele mistura client+server). `worker/src/index.ts` exporta `ConversationAgent extends Agent<Env>` (stub vazio; implementação real na fase 4) + handler fetch com `GET /api/health` e CORS aberto (`json()` helper já aplica headers). `satisfies ExportedHandler<Env>`.
- **Bindings (`worker/wrangler.jsonc`):** DO `ConversationAgent` (class `ConversationAgent`, migration `v1` em `new_sqlite_classes`); D1 binding `DB`, database_name `goodchat`, `database_id` placeholder zeros — local dev ignora; trocar pelo id real de `wrangler d1 create goodchat` antes do 1º deploy. `compatibility_date 2026-08-01`, `nodejs_compat`.
- **Types do worker:** `npm run cf-typegen` (`wrangler types`) gera `worker-configuration.d.ts` (commitado; regenerar após mudar wrangler.jsonc). `Env` vem de lá — sem `@cloudflare/workers-types` manual.
- **Comandos:** worker `npm run dev` (= `wrangler dev --port 8000`), `npm run typecheck`; app `npm run dev` (5173), `npm run build`, `npm run typecheck`. Testado: health ok, OPTIONS 204 com CORS, typecheck verde nos dois, build do app ok.
- **Tema:** `app/src/styles/palettes.css` (único lugar com hex, tokens `--palette-*`) + `app/src/index.css` com `@plugin "daisyui" {themes:false}`, temas `goodchat-light` (default) / `goodchat-dark` (`prefersdark: true`), tokens via `var(--palette-*)` — funciona. Extras por tema: `--shadow`, `--scanline-color`, `--frame-border: 2px` (só no light). Utilities `@utility`: `retro-shadow(-sm)`, `retro-border`, `terminal-cursor` (+ `@keyframes blink`), `terminal-scanline`, `btn-goodchat(-outline)` via tokens do btn (`--btn-color/--btn-fg/--btn-border/--btn-p/--size/--fontsize`, weight 900, uppercase). Fonte: `@fontsource/jetbrains-mono` 400/500/700/800 + itálicos; `--font-sans` e `--font-mono` aliasados no `@theme`.
- **Decisões:** par **hub** (cream/crimson · noir/rose) conforme recomendação do styleguide §8; `secondary-content`/`neutral-content` = white (light) / noir (dark) — styleguide não especificava; status light = cor cheia + texto white, dark = soft + texto near-black; componente `input` do daisyUI **incluído** (sem exclude de componentes por ora); toggle de tema via `data-theme` no `<html>` (default `goodchat-light` no index.html).
- **Demo:** `app/src/App.tsx` (página temporária, substituir na fase 5) — botões, card, preview de bolhas, badges de status, scanline `opacity-10`, cursor piscando, footer com `LINK: ONLINE` (fetch em `VITE_API_URL ?? http://localhost:8000` → `/api/health`).
- **Pendência:** verificação visual no browser não rodou (extensão Chrome sem resposta) — estrutura validada via build + curl; conferir visualmente em `localhost:5173` nos dois temas.

---

## Fase 2 — D1 + Auth

**Objetivo:** login funcional com sessão persistente em cookie seguro; criação de contas por admin.

**Ler antes:** `.harness/prd.md` §3.1, §4.3; handoff da fase 1.

**Tarefas:**
1. Verificar lib de hash compatível com runtime Workers (Argon2id ou scrypt — ex.: WASM ou `crypto.subtle`-based). Registrar escolha no handoff.
2. Migrations Wrangler versionadas: tabelas `users`, `sessions`, `conversations` exatamente como PRD §4.3 (conversations já entra aqui — schema junto, uso na fase 3). Aplicar local.
3. Endpoints: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. Token opaco 256-bit, cookie `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=N`, sliding expiration + cap 30 dias, logout invalida linha no D1.
4. Middleware de validação de sessão reutilizável (REST e futuro upgrade WS).
5. Criação de conta: script/CLI admin (`wrangler d1 execute` wrapper ou endpoint protegido por secret) — sem sign-up público. Seed com 2 usuários de teste (rule: outro dev roda e testa sem setup manual).
6. Rate limiting de login (por IP e por conta) — pode ser contador no D1 ou DO simples.

**Critérios de aceite:** login com usuário seed devolve cookie; `me` autenticado responde; logout revoga (repetir `me` → 401); senha errada 5x → rate limit; migrations aplicam do zero num banco limpo.

**Não fazer:** UI de login (fase 5), WebSocket, lookup de usuários.

**Handoff (concluída 2026-08-17):**

- **Hash:** PBKDF2-SHA-256 100k iterações via `crypto.subtle` nativo (`src/lib/password.ts`, formato `pbkdf2-sha256$<iter>$<salt b64>$<hash b64>`). Motivo: Workers capa PBKDF2 em 100k iterações e free tier tem 10ms CPU — scrypt/argon2 puro-JS/WASM estouram; 100k < OWASP 600k, trade-off aceito (instância fechada + rate limit), documentado no código. Sem lib externa de hash. Módulo roda em Workers **e** Node ≥24 — scripts CLI importam o mesmo arquivo (hash idêntico).
- **Migrations:** `worker/migrations/0001_init.sql` (users, sessions, conversations, login_attempts). Aplicar: `npm run db:migrate` (= `wrangler d1 migrations apply goodchat --local`). Extras vs PRD §4.3: `username UNIQUE COLLATE NOCASE`; `conversations` com `CHECK (user_a < user_b)` + unique(user_a,user_b) — fase 3 deve ordenar o par antes de inserir; `sessions.token` guarda **SHA-256 hex do token**, nunca o token cru (leak de DB não vira sessão); `login_attempts(key,count,window_start)` pro rate limit.
- **Sessão:** token opaco 256-bit hex no cookie `session=...; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=N`. Sliding 7d + cap 30d desde criação; refresh só persiste se ganhar ≥1h (evita write por request) — quando refresca, resposta traz novo `Set-Cookie`. `requireSession(request, db)` em `src/lib/session.ts` devolve `{user, refreshedCookie?}` ou `Response` 401 pronta — reusável pro upgrade WS (fase 4, lê header Cookie).
- **Endpoints:** `POST /api/auth/login` ({username,password}, Zod) → 200 {user}+cookie; `POST /api/auth/logout` → 200 {ok}+cookie limpo (idempotente); `GET /api/auth/me` → {user} | 401. Shape de user público: `{id, username, display_name, avatar_url, created_at}` (timestamps em **ms**). Erros sempre `{error: <código>, message?}`: `invalid_request` 400, `invalid_credentials` 401, `unauthorized` 401, `rate_limited` 429 (+ header `Retry-After`), `not_found` 404.
- **CORS mudou:** `Allow-Credentials: true` proíbe `*` literal com cookie — agora **reflete o Origin** da request (qualquer origem continua aceita) + `Vary: Origin`. Aplicado centralmente no `fetch` (`src/lib/http.ts`); handlers não põem CORS. Frontend usa `credentials: 'include'`.
- **Rate limit:** janela fixa 15min em D1 — 5 falhas/conta, 20/IP (`CF-Connecting-IP`, fallback `unknown`). Bloqueado → 429 mesmo com senha certa; sucesso limpa contador da conta. `src/lib/ratelimit.ts`.
- **Criar usuário:** só CLI, sem endpoint admin (menos superfície; decisão registrada) — `npm run user:create -- <username> <senha> [display name]` (username `^[a-z0-9_]{3,20}$`, senha ≥8). Seed: `npm run db:seed` (idempotente) cria **`alice` / `alice-goodchat`** e **`bob` / `bob-goodchat`**. Scripts em `worker/scripts/*.ts`, rodam com Node 24 (type stripping nativo, sem build); fora do tsconfig (typecheck cobre só `src/`). Setup zero: `db:migrate` + `db:seed` + `dev`. `ADMIN_SECRET` removido do `.env.example` — nenhum secret necessário nesta fase.
- **Login username:** normalizado lowercase/trim no login; lookup case-insensitive (COLLATE NOCASE). Usuário inexistente responde igual a senha errada (sem enumeração).
- **Testado:** fluxo completo via curl (login→me→logout→me 401), 5 falhas → 429 com senha certa, migrations+seed do zero após `rm -rf .wrangler/state`, user criado por CLI loga. Typecheck verde.

---

## Fase 3 — Usuários + conversas (REST)

**Objetivo:** achar usuário por `@username` e materializar conversa determinística.

**Ler antes:** `.harness/prd.md` §3.2, §3.3, §4.3; handoffs 1–2.

**Tarefas:**
1. `GET /api/users/lookup?q=` — match exato/prefixo, visibilidade Opção A (todos visíveis — PRD §3.2.1 recomenda; confirmado salvo aviso contrário). Autenticado.
2. `conversation_id` determinístico: hash do par ordenado (`hash(min(a,b), max(b,a))` — SHA-256 truncado ou similar; documentar no handoff).
3. `GET /api/conversations` — lista do usuário logado com metadados (outro participante, `last_message_at`; preview de última mensagem fica para fase 4/5 — vem do DO).
4. Criação lazy: registro em `conversations` criado na primeira mensagem (a inserção real acontece na fase 4 via DO/Worker; aqui entra o helper compartilhado + endpoint `POST /api/conversations/resolve` que devolve o id sem criar).
5. Testes rápidos via curl documentados nos scripts do pacote.

**Critérios de aceite:** lookup devolve seed users por prefixo; mesmo par de usuários → sempre mesmo id, independente da ordem; lista vazia para usuário novo responde 200.

**Não fazer:** WebSocket, mensagens, UI.

**Handoff (concluída 2026-08-17):**

- **conversation_id:** `SHA-256("v1:" + min(idA,idB) + ":" + max(idA,idB))` truncado a 128 bits = **32 hex chars**. Implementação em `worker/src/lib/conversation.ts`: `orderPair`, `conversationIdFor(a,b)` (qualquer ordem), e **`ensureConversation(db, a, b, lastMessageAt)`** — helper da criação lazy pra fase 4: `INSERT ... ON CONFLICT(id) DO UPDATE SET last_message_at = MAX(atual, novo)` (upsert único, idempotente, nunca retrocede timestamp; lança erro se a===b). Fase 4 chama ensureConversation a cada mensagem persistida (cobre criação + bump de `last_message_at` numa tacada).
- **`GET /api/users/lookup?q=`** (autenticado): prefixo case-insensitive, aceita `@bob` ou `bob`, escapa wildcards de LIKE (`_`/`%`/`\`), **exclui o próprio usuário**, LIMIT 20, ordena por username. Resposta `{users: [<user público>]}`. `q` vazio → 400 `invalid_request`. Visibilidade Opção A confirmada (todos visíveis).
- **`GET /api/conversations`** (autenticado): `{conversations: [{id, created_at, last_message_at, other_user: <user público>}]}` ordenado por `COALESCE(last_message_at, created_at) DESC`. Sem linhas → `{conversations: []}` 200. Preview de última mensagem fica pra fase 4/5 (vem do DO), como planejado.
- **`POST /api/conversations/resolve`** (autenticado, body `{user_id}` Zod): devolve `{conversation_id, exists, other_user}` **sem criar nada** — `exists` indica se a linha já foi materializada por primeira mensagem. Próprio id → 400; user inexistente → 404 `not_found`.
- Todos os endpoints autenticados propagam `refreshedCookie` do sliding session como `Set-Cookie` (padrão da fase 2 mantido).
- **Rotas** registradas em `src/index.ts`; shape de user público e de erro idênticos à fase 2.
- **Smoke test:** `npm run smoke:phase3` (`worker/scripts/smoke-phase3.ts`, Node puro, exige dev server na 8000 + seed) — cobre: 401 sem sessão, prefixo/`@`exato, exclusão de self, q vazio 400, resolve simétrico (alice→bob === bob→alice), self 400, ghost 404, lista vazia 200. Equivalentes curl documentados no header do script. Rodado: **all green**. Teste manual extra: linha inserida à mão → `exists: true` e lista populada dos dois lados (linha removida depois; `conversations` local está vazio).
- **Decisões:** lookup exclui self (schema proíbe conversa consigo — `CHECK user_a < user_b`); prefixo `v1:` no hash permite migrar algoritmo sem colidir; sem rate limit nos endpoints novos (só sessão) — reavaliar se instância crescer.

---

## Fase 4 — Real-time core (DO + WebSocket)

**Objetivo:** duas conexões trocando mensagens em tempo real com persistência e entrega offline. Coração do produto.

**Ler antes:** `.harness/prd.md` §3.4, §4.1, §4.4, §4.5, §4.6; handoffs 2–3.

**Tarefas:**
1. Verificar docs atuais: Agents SDK vs DO puro, e **WebSocket Hibernation API** (é o padrão atual? usar se sim — custo zero idle é requisito do PRD §5).
2. Agent/DO `ConversationAgent`, 1 instância por `conversation_id` (idFromName). Schema SQLite interno `messages` exatamente PRD §4.4.
3. Worker: rota `GET /api/ws/:conversationId` — valida cookie de sessão, confirma que o usuário pertence ao par, upgrade e encaminha pro DO. Na primeira mensagem persistida, cria a linha em `conversations` (criação lazy, helper da fase 3) e atualiza `last_message_at`.
4. Protocolo exatamente PRD §4.5: entrada `send_message`/`typing`/`read_receipt`; saída `message`/`message_status`/`typing`/`read_receipt`. Zod nos dois sentidos.
5. At-least-once + dedup por `client_id` (echo pro remetente com status). Estados `sent → delivered → read`.
6. Histórico: ao conectar, DO envia últimas N mensagens (ou endpoint de fetch via DO) + tudo não entregue desde a última conexão (entrega offline).
7. Teste de integração mínimo com 2 clientes WS (script Node ou vitest) provando: entrega online, dedup, entrega pós-reconexão.

**Critérios de aceite:** script de teste com 2 conexões troca mensagens; mensagem enviada com destinatário desconectado chega na reconexão; `client_id` repetido não duplica; mensagens sobrevivem a restart do dev server (persistência DO).

**Não fazer:** UI, mídia, stickers. Typing/read chegam no protocolo mas UI só na fase 7.

**Handoff (concluída 2026-08-17):**

- **Hibernation: SIM** — é o default do Agents SDK (`Agent.options = { hibernate: true }`, via `HibernatingConnectionManager` do partyserver). Deixado explícito na classe (`static override options`). Custo idle zero; `conn.setState()` sobrevive hibernação (attachment do WebSocket).
- **Arquivos:** `worker/src/agent.ts` (`ConversationAgent`, movido do index), `worker/src/protocol.ts` (Zod nos dois sentidos — **fase 5 importa/copia esses shapes**), `worker/src/routes/ws.ts` (upgrade). `wrangler.jsonc` não mudou (binding/migration da fase 1 serviu).
- **Rota WS:** `GET /api/ws/:conversationId?with=<other_user_id>`. Cookie de sessão no handshake (browser manda; teste usa lib `ws` com header Cookie). Validação de pertencimento **sem exigir linha em `conversations`** (criação lazy): recomputa `conversationIdFor(me, with)` e compara com o path → 403 se divergir; 401 sem sessão, 404 user inexistente, 400 malformado/self, 426 sem Upgrade. Worker **sobrescreve** headers `x-goodchat-user-id`/`x-goodchat-peer-id` (nunca confia no cliente) e encaminha via `getAgentByName(env.ConversationAgent, conversationId)` + `stub.fetch()`. Rota tratada **antes** do wrapper CORS do `index.ts` — resposta 101 não pode ser reconstruída (e WS não usa CORS).
- **DO:** tabela `messages` exata PRD §4.4 (coluna `type` no disco, `msg_type` no wire) + índice único `(sender_id, client_id)` = dedup at-least-once; tabela `participants` pina o par no 1º connect (defesa em profundidade — conexão de terceiro fecha 1008 mesmo se o Worker falhar).
- **Protocolo:** PRD §4.5 + extensões aditivas documentadas no `protocol.ts`: frame `history` no connect; `message` carrega `client_id`+`status` (receber o próprio `message` de volta = ack "sent" — **não há** `message_status: sent` separado); `message_status` carrega `id` além de `client_id` (transições de mensagens de sessões antigas); frame `error` (socket fica aberto). Body cap 4096 chars.
- **Entrega:** peer com conexão viva no send → grava e broadcasta já `delivered`. Offline → `sent`; quando destinatário conecta: `UPDATE sent→delivered` + `message_status` pro remetente + `history` contígua por rowid (janela = últimas **N=50** ∪ tudo que estava não-entregue, mesmo que mais antigo). `read_receipt {up_to_message_id}` → `UPDATE status='read'` onde `sender != leitor AND rowid <= alvo`; broadcast do frame `read_receipt` (sem frames por-mensagem). Typing: efêmero, broadcast só pra conns de `state.userId != sender` (multi-tab não vê o próprio typing).
- **D1:** `ensureConversation` (helper fase 3) a cada mensagem persistida, **depois** do broadcast (D1 fora do caminho de latência), com try/catch + log.
- **Teste:** `npm run smoke:phase4` (dev na 8000 + seed; 18 checks — handshake negativo, history, entrega online/offline/reconexão, dedup, receipts, typing, payload inválido, linha lazy no D1). Idempotente entre runs: client_ids únicos + storage do DO persiste em `.wrangler/state`. Persistência pós-restart verificada à parte (restart do wrangler → history intacta com estados `read`/`delivered`). Rodado: **all green**. devDeps novas: `ws` + `@types/ws` (WebSocket global do Node não aceita header Cookie).
- **Pegadinhas Agents SDK:** (1) sem `shouldSendProtocolMessages() => false` o SDK manda frames `cf_agent_identity`/`cf_agent_state`/`cf_agent_mcp_servers` pro cliente raw no connect; (2) o wrapper interno de `onMessage` intercepta JSON com shapes internos (state sync/RPC) antes do handler do usuário — nossos types não colidem; (3) `AgentNamespace` é alias deprecated de `DurableObjectNamespace` — o binding gerado pelo `cf-typegen` serve direto no `getAgentByName`; (4) scripts Node com type stripping não aceitam parameter properties (`constructor(private ws: ...)`).

---

## Fase 5 — Frontend do chat

**Objetivo:** app usável de ponta a ponta: login → lista de conversas → thread → enviar/receber em tempo real. Tema retro desde o primeiro componente.

**Ler antes:** `.harness/styleguide.md` §4–§7, `.harness/prd.md` §3.3, §3.7; handoffs 2–4 (shapes de API e protocolo WS).

**Tarefas:**
1. Estrutura: React Router (ou estado simples), fetch client com cookie (`credentials: include`), telas Login / ConversationList / Thread.
2. Login: card `retro-border` + `retro-shadow`, `btn-goodchat`, estados de erro com tokens de status. Sessão persistente (checa `me` na carga).
3. Lista de conversas: itens no padrão "tile interativo" do styleguide §6 (hover accent + `-translate-y-1`), busca `@username` inline (lookup fase 3) para iniciar conversa nova, badge de não lidas.
4. Thread: bolhas conforme styleguide §6 (recebida base-200/borda, enviada accent, radius 0, `retro-shadow-sm`), metadados em micro-texto mono, escape rígido de conteúdo (nunca HTML cru), auto-scroll.
5. Composer: campo retro + envio com Enter, `client_id` UUID por mensagem, estado `sending → sent` otimista.
6. Cliente WS: conexão por conversa aberta, reconnect com backoff exponencial + resync de histórico, indicador de conexão (micro-texto estilo `LINK: ONLINE`).
7. Entradas: só fade/slide `withTiming`-style (CSS transitions ease-out ≤260ms). Scanline overlay opcional global.
8. Decisões pendentes do styleguide §8 assumidas: par **hub** (cream/crimson · noir/rose), manter `font-black`, incluir scanline, incluir componente `input` do daisyUI. Se usuário já tiver decidido diferente, handoff da fase 1 manda.

**Critérios de aceite:** dois browsers logados com os seed users conversam em tempo real; refresh mantém sessão e recarrega histórico; mensagem offline chega ao reabrir; XSS test (`<script>`, `<img onerror>`) renderiza como texto; UI visivelmente retro nos dois modos (comparar com styleguide), zero estilo daisyUI default.

**Não fazer:** upload de mídia, emoji picker, receipts/typing na UI.

**Handoff (concluída 2026-08-17):**

- **Worker ganhou preview/unread** (adiado da fase 3 "vem do DO"): `ConversationAgent.onRequest` interno `GET /summary` (header `x-goodchat-user-id`; só alcançável via código do Worker — router público não encaminha HTTP puro pro DO) devolve `{last_message, unread_count}` (exclui `deleted_at`); `GET /api/conversations` agora enriquece cada linha via `getAgentByName(...).fetch('https://do/summary')` em paralelo, degradando pra `last_message: null / unread_count: 0` se um DO falhar. Unread = mensagens do peer com `status != 'read'`.
- **Estrutura do app:** `src/lib/` — `api.ts` (client REST, `credentials: include`, classe `ApiError {code,status}`, `wsUrl()`), `protocol.ts` (**cópia literal** de `worker/src/protocol.ts` + header avisando; manter em sync — app agora depende de `zod`), `router.ts` (hash router mínimo: `#/` lista, `#/t/<userId>` thread; login não é rota — renderiza quando sessão anônima). `src/hooks/` — `useSession.tsx` (context provider; `me` na carga, login/logout), `useTheme.ts`, `useConversation.ts`. `src/screens/` — `LoginScreen`, `ConversationsScreen`, `ThreadScreen`. `src/components/` — `Avatar`, `WindowDots`, `RetroIconButton` (tile compacto pra toolbar — btn-goodchat é tamanho CTA), `MessageBubble`, `Composer`, `UserSearch`, `ConversationTile`.
- **useConversation** (coração): reconnect com backoff exponencial + jitter (0.5s→10s); frame `history` no (re)connect substitui estado servidor **mantendo e reenviando** otimistas não-ackados (dedup server por client_id — at-least-once); echo do próprio `message` = ack (status local `'sending'` → server status); `message_status` só **sobe** status (rank sending<sent<delivered<read — cobre corrida status-antes-do-echo); `read_receipt` do peer marca minhas mensagens read; typing ignorado (fase 7). `send()` gera `client_id` UUID, otimista imediato, fila se socket fechado (flush no onopen). `markRead(upToId)` deduplica por ref e re-envia após reconexão (ref zerada no onopen).
- **Read receipt já é DISPARADO na fase 5** (ThreadScreen, quando aba visível — `visibilitychange` ouvido): sem isso a badge de não lidas nunca zeraria. O que fica pra fase 7 é *renderizar* receipts/typing (bolha própria mostra só `enviando_` → hora).
- **Tema:** `index.html` **não pina mais** `data-theme` — sem escolha salva, `prefersdark` do daisyUI decide; toggle grava `localStorage['goodchat-theme']` e seta o atributo. Entrada nova: `@utility animate-enter` (fade+slide 8px, 200ms, cubic-bezier ease-out, zero overshoot).
- **Lista:** polling 15s **só com aba visível** + refresh no `visibilitychange`; preview de mídia vira `[imagem]`/`[vídeo]`/`[sticker]`/`[arquivo]`.
- **E2E validado no Chrome real** (alice no browser, bob via script `ws` Node): login→lista→thread; tempo real nos 2 sentidos; XSS (`<script>`, `<img onerror>`) renderiza como texto (React escapa; nunca HTML cru); refresh mantém sessão+rota+histórico; entrega offline chega na reconexão; badge 5→0 após leitura; light+dark conferidos. **Pegadinha de automação:** janela do Chrome da extensão fica `visibilityState: 'hidden'` → poll e markRead (corretamente) não disparam; pra testar via automação, forjar `Object.defineProperty(document,'visibilityState',{value:'visible'})` + dispatch `visibilitychange`.
- **Rodar e2e manual:** worker `npm run dev` (8000) + `db:migrate`+`db:seed`; app `npm run dev` (5173); dois browsers/perfis com `alice`/`alice-goodchat` e `bob`/`bob-goodchat`.
- **Dívidas:** lista não atualiza em tempo real (só poll 15s) — candidato fase 7+/DO de presença; sem separador de dia na thread; smoke:phase3 falha 1 check (`exists:false`) se rodado após smoke:phase4 no mesmo estado — limpar `.wrangler/state` antes; aviso oxlint fast-refresh em `useSession.tsx` (provider+hook no mesmo arquivo, aceito).

---

## Fase 6 — Pipeline de mídia (B2)

**Objetivo:** enviar e ver imagens (P0) e vídeos curtos (P1) nas conversas.

**Ler antes:** `.harness/prd.md` §3.5, §5; handoffs 4–5.

**Tarefas:**
1. Setup B2: bucket + application keys; documentar em `.env.example`; domínio Cloudflare na frente (Bandwidth Alliance) — se conta/DNS não disponível, servir via URL B2 direta em dev e registrar pendência.
2. Worker: `POST /api/media/upload-url` — valida sessão, MIME allowlist, tamanho máx; devolve URL pré-autorizada B2. Validação server-side obrigatória mesmo com client validando.
3. Client: compressão antes do upload (canvas/`createImageBitmap` para imagem ≤1–2MB; vídeo cap 60s — verificar viabilidade de compressão de vídeo no browser, senão só validar tamanho/duração).
4. Fluxo completo PRD §3.5: upload direto ao B2 → mensagem `image`/`video` com `media_key` → DO persiste e broadcasta → destinatário renderiza (thumb na bolha, clique amplia num modal retro).
5. Placeholder/estado de upload no composer (progresso em micro-texto mono).

**Critérios de aceite:** imagem enviada de um browser aparece no outro em tempo real e após reload; MIME proibido/oversize rejeitado pelo Worker (não só client); bytes não passam pelo Worker (upload direto B2).

**Não fazer:** stickers (fase 7), encriptação de mídia, retenção/cleanup (registrar como pendência).

**Handoff (concluída 2026-08-17):**

- **Sem conta B2 disponível** — pipeline completo implementado contra a **API S3-compatível** do B2 (presigned PUT), com **stub fake-B2 local** pra dev/teste: `worker/scripts/media-dev-server.ts` (`npm run media:dev`, porta 9000, storage em `worker/.media-dev/` gitignorado, CORS aberto, **não** valida assinatura). `worker/.dev.vars` (gitignorado, criado) aponta pro stub; trocar pelos valores reais quando o bucket existir — receita completa passo-a-passo no `worker/.env.example` (bucket público, application key escopada, CORS rules s3_put/s3_get no bucket, endpoint S3, URL pública).
- **Presign:** `aws4fetch` 1.0.20 (`worker/src/lib/media.ts`), SigV4 query-signed, TTL 600s, região extraída do hostname do endpoint. **Content-Type e Content-Length entram na assinatura** (`allHeaders: true` — aws4fetch os pula por default), então o próprio B2 rejeita bytes com MIME/tamanho diferentes do aprovado; verificado contra B2 real = pendência (stub não valida assinatura).
- **`POST /api/media/upload-url`** (`worker/src/routes/media.ts`): sessão obrigatória; allowlist `image/{jpeg,png,webp,gif}` + `video/{mp4,webm}`; caps **imagem 8MB / vídeo 32MB** (headroom pra GIF; alvo pós-compressão é ~1.5MB); erros `unsupported_media_type` 415, `payload_too_large` 413, `media_not_configured` 503 (env B2 ausente). Resposta: `{key, upload_url, headers, public_url, expires_in}`.
- **Keys:** `media/<yyyy-mm>/<uuid>.<ext>` — prefixo mensal deixa retenção/cleanup futuro trivial (`b2 rm` por prefixo); uuid = não-adivinhável (bucket público serve por capability-URL). Env novas: `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `B2_S3_ENDPOINT`, `B2_PUBLIC_BASE_URL` (typegen atualizado; guard runtime pra prod sem secrets).
- **Serving:** URL pública direta (`<base>/<key>`), bytes nunca passam pelo Worker (upload nem download). App usa **`VITE_MEDIA_URL`** (deve casar com `B2_PUBLIC_BASE_URL`; default = stub local) — duplicação de config registrada e documentada nos dois `.env.example`.
- **Client (`app/src/lib/media.ts`):** imagem comprimida via `createImageBitmap`+canvas → WebP (fallback JPEG), max 2048px, qualidade decrescente até ≤1.5MB; **GIF passa direto** (canvas mataria a animação). **Vídeo: compressão no browser descartada** (MediaRecorder re-encode é lento/instável; WebCodecs = peso demais pra fase) — só validação: duração ≤60s (metadata) + ≤32MB. Upload via **XHR** (fetch ainda não expõe progresso de upload) com `onprogress` + abort.
- **Composer:** tile `+` abre file picker; strip de status acima do campo (`processando_` → `upload: N%` + barra + cancelar); erros em micro-texto (formato/tamanho/duração/rede). Mensagem só é enviada **depois** do PUT concluir — otimista já renderiza do URL público. `useConversation` ganhou `sendMedia(msgType, mediaKey)` (refactor: `sendEvent` interno compartilhado).
- **Render:** `MessageBubble` — imagem `max-h-64` clicável → **lightbox** `<dialog>` nativo + classes modal do daisyUI (retro-border + retro-shadow, backdrop fecha, Esc nativo); vídeo `<video controls preload="metadata">` inline. Body vazio em mídia não renderiza `<p>`. Preview `[imagem]`/`[vídeo]` na lista já existia da fase 5.
- **Testado:** `npm run smoke:phase6` (sobe o stub in-process se a 9000 estiver livre; 13 checks — 401/415/413, shape do presign com content-length+content-type assinados, upload direto sem passar pelo Worker, PUT→GET roundtrip, entrega WS em tempo real com media_key, history pós-reconexão, `media_key_required` do DO) — **all green**. E2E no Chrome real (alice UI + bob via script `ws`): upload pela UI com compressão, imagem chega no outro lado em tempo real, resposta do bob renderiza na alice, reload mantém tudo, lightbox abre/fecha, console sem erros, light+dark ok.
- **Decisões/pendências:** bucket real B2 + application keys **não criados** (sem conta) — só trocar `.dev.vars`/secrets quando existir; domínio Cloudflare na frente do B2 (Bandwidth Alliance) pendente junto; validação da assinatura content-length contra B2 real pendente; retenção/cleanup de mídia segue pendência (prefixo mensal já preparado); vídeo e2e no browser não exercitado (protocolo coberto pelo smoke).

---

## Fase 7 — Receipts, typing, emoji, stickers

**Objetivo:** camada de riqueza conversacional (P1s do PRD).

**Ler antes:** `.harness/prd.md` §3.4 (estados/typing), §3.5 (stickers), §2.2 UC4/UC7/UC8; handoffs 4–6; styleguide §4 (motifs) e §6.

**Tarefas:**
1. Emoji: picker client-side (lib leve, ex. `emoji-picker` verificar atual) no composer; emoji inline é Unicode puro — sem tratamento server.
2. Delivery/read receipts na UI: estados `sent/delivered/read` do protocolo (fase 4) renderizados em micro-texto/ícone mono na bolha; `read_receipt` disparado ao visualizar thread.
3. Typing indicator: evento `typing` com debounce no composer; exibição = micro-texto uppercase + `terminal-cursor` piscando (styleguide §6 — sem bolinhas saltitantes).
4. Stickers: pack curado versionado em B2 (assets estáticos), manifest JSON; picker no composer; mensagem tipo `sticker` com asset ID; render sem borda de bolha ou com tratamento próprio (decidir visual na hora, dentro da família retro).

**Critérios de aceite:** dois browsers — typing aparece/some correto; receipts progridem até `read`; emoji e sticker vão e voltam persistidos; nada disso quebra entrega offline.

**Não fazer:** edição/deleção de mensagens (P1 separado — sugerir como fase extra se usuário quiser), E2EE.

**Handoff (concluída 2026-08-17):**

- **Emoji: `emoji-picker-element` 1.29.1** (web component, shadow DOM) + `emoji-picker-element-data` 1.8.0 — dataset **self-hosted** (sem CDN): `import ... from 'emoji-picker-element-data/pt/cldr/data.json?url'` (Vite emite asset ~455KB, gzip 78KB, buscado só na 1ª abertura; lib cacheia em IndexedDB). Locale `pt` + i18n `emoji-picker-element/i18n/pt_BR.js`. Tudo lazy: `EmojiPicker.tsx` monta o componente via dynamic import na primeira abertura do dropdown e ele **fica montado** (reabertura instantânea). Tema: shadow DOM não vê tokens do daisyUI — classe `light`/`dark` pinada via `currentTheme()` (exportado de `useTheme.ts`) e **re-sincronizada** por MutationObserver em `data-theme` + listener de `prefers-color-scheme`; cores/geometria via API de CSS vars do componente (bloco `emoji-picker { ... }` no `index.css`, radius 0, borda 0 — o shell do popover já desenha o retro-border). Inserção **no caret** do textarea (selection sobrevive ao blur; restaurada pós-render), picker fica aberto pra inserir vários. Emoji inline = Unicode puro em `msg_type: 'text'` (o `msg_type: 'emoji'` do protocolo segue aceito, nunca emitido pela UI).
- **Pickers = daisyUI focus dropdown** (`dropdown dropdown-top` + `dropdown-content`; fecha ao clicar fora/perder foco; sticker envia e fecha via `blur()`). Botões novos no composer: `:)` (emoji) e `▦` (stickers), mesmo tratamento do tile `+`.
- **Stickers:** pack curado **v1** em `worker/assets/stickers/v1/` — 10 SVGs autorais (pixel-art por `<rect>` + texto terminal mono; placa cream + borda ink **baked** no asset, então funciona nos dois temas com o mesmo arquivo; app só adiciona `retro-shadow-sm`). Manifest: `{version, base: "stickers/v1", stickers: [{id, file, label}]}` em `manifest.json`. Publicação: `npm run stickers:publish` (PUT puro no fake-B2; `MEDIA_PUT_BASE` sobrescreve; **B2 real precisa de PUT assinado → `b2 sync`**, receita no `.env.example`). Client: `app/src/lib/stickers.ts` busca `<VITE_MEDIA_URL>/stickers/v1/manifest.json` (cache module-level, promise falha não envenena o cache), `useStickerPack()` hook; mensagem = `msg_type: 'sticker'`, `body` = id do asset (PRD §4.4); render **sem chrome de bolha** (só o asset + meta-linha), id desconhecido → fallback `[sticker]`, carregando → `skeleton`.
- **Protocolo:** só endurecimento aditivo — `STICKER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/` exportado nos dois `protocol.ts`; DO rejeita sticker fora do padrão com `error: 'invalid_sticker'` (body vira segmento de URL no client — sem path traversal). Nenhum frame novo; `typing` da fase 4 usado como está.
- **Typing:** `useConversation` ganhou `sendTyping()` (throttle leading 2.5s, **nunca enfileirado** — hint efêmero não sobrevive reconexão) e `peerTyping` (frame arma expiry de 4s; mensagem real do peer limpa na hora). Composer chama `onTyping` a cada change. Render: linha de altura fixa (`h-4`, zero layout shift) acima do composer — `@username digitando_` accent + `terminal-cursor`, `aria-live="polite"`.
- **Receipts UI:** `MetaLine` no `MessageBubble` — bolha própria mostra `hh:mm · enviado|entregue|lido` (lido em `font-black`); recebida mostra só hora; `enviando_` mantido. `sendSticker(id)` reusa `sendEvent` → fila offline/dedup grátis.
- **Bugs achados no e2e e corrigidos:** (1) tema salvo só era pinado no `<html>` pelo `useTheme`, que monta apenas na lista — a thread caía no `prefers-color-scheme` quando o SO virava dark; agora `applyStoredTheme()` roda no boot (`main.tsx`). (2) classe de tema do emoji picker congelava na 1ª abertura (ele fica montado) — resolvido pelo observer acima.
- **Testado:** `npm run smoke:phase7` (17 checks — publish+roundtrip do pack com content-type, ids vs regex, typing peer-only sem eco nas próprias tabs, emoji byte-identical persistido, sticker online/offline/reconexão, 4 ids inválidos rejeitados sem vazar pro peer, read receipt em sticker) — **all green**, idempotente. E2E no Chrome real (alice UI + bob via scripts `ws`): typing aparece/some (expiry), receipts progridem até `lido` ao vivo, emoji picker (pt-BR, temado, insere no caret, multi-insert), sticker pela UI chega/persiste pós-reload, entrega offline de sticker vira `delivered` na reconexão, light+dark conferidos (stickers com placa cream “colada” no noir — efeito desejado).
- **Pendências novas:** publicar `stickers/v1/` no B2 real quando o bucket existir (`b2 sync`, junto das pendências da fase 6); throttle 2.5s do typing < expiry 4s por design — se mudar um, manter `throttle < expiry`.

---

## Fase 8 — PWA + push (stretch)

**Objetivo:** instalável + notificações com opt-in explícito.

**Ler antes:** `.harness/prd.md` §3.8, §7 fase 3; handoffs 5 e 7.

**Tarefas:**
1. Manifest + ícones (gerar no estilo retro) + service worker (cache estático mínimo, sem cache de API).
2. Web Push VAPID direto do Worker: tabela de subscriptions (D1), opt-in explícito na UI, push disparado pelo DO quando destinatário offline.
3. Verificar suporte atual de Web Push em iOS/Safari PWA e documentar limitações.

**Critérios de aceite:** app instala (Lighthouse PWA pass); com app fechado, mensagem gera notificação em browser suportado; sem opt-in → nenhuma subscription criada.

**Handoff (concluída 2026-08-17):**

- **Lib: `@mmmike/web-push` 1.3.0** (zero deps, WebCrypto puro, **RFC 8291 `aes128gcm`** + RFC 8292 VAPID, envia via `fetch` — mesmo pacote roda no workerd, no Node dos scripts e no browser via `/client`). O guia oficial CF Agents recomenda `web-push` clássico — descartado: depende de shims node:https/node:crypto e só fala o coding legado `aesgcm`; `@block65/webcrypto-web-push` e `@pushforge/builder` também são aesgcm legado (risco com o push service da Apple, que segue RFC 8291). Decisão registrada no commit.
- **VAPID:** `npm run vapid:generate` (usa a própria lib; formato = mesmo do web-push CLI: b64url raw 65B pública / 32B privada). Keys em `worker/.dev.vars` (gitignored — **par dev já preenchido localmente**; outro dev roda vapid:generate e cola, receita no `.env.example`); prod = `wrangler secret put VAPID_PRIVATE_KEY` etc. **App não tem env de push** — busca a pública de `GET /api/push/vapid-public-key`. Rotacionar o par mata todas as subscriptions.
- **D1:** migration `0002_push_subscriptions.sql` — `push_subscriptions(endpoint PK, user_id FK CASCADE, p256dh, auth, created_at)` + índice user_id. Endpoint é capability URL (quem tem, empurra push) — **nunca logar**; erros logam só status code.
- **Endpoints** (`worker/src/routes/push.ts`): `GET /api/push/vapid-public-key` (503 `push_not_configured` sem env — feature desliga limpa); `POST /api/push/subscribe` (Zod; upsert por endpoint, re-vincula ao user atual; **endpoint precisa ser https** = guard SSRF — linha armazenada vira alvo de fetch outbound); `POST /api/push/unsubscribe` (só apaga linha própria; devolve `{removed}`).
- **Disparo** (`agent.ts handleSend`): só quando `!peerOnline`, via `this.ctx.waitUntil(pushToPeer(...))` — round-trip ao push service (timeout 30s da lib) fora do caminho de frames. Payload `{title: '@<username>', body: preview PT-BR (mesmos rótulos da lista, 120 code points), url: '/#/t/<senderId>', tag: conversationId}`; ttl 24h, urgency high, **topic = tag** (32 hex ≤ cap de 32 — na fila do push service, push novo da mesma conversa substitui o antigo). `notifyUser` nunca lança; 404/410 → DELETE da linha; outros erros só logam.
- **App:** `public/sw.js` (sem build): cache `goodchat-v1` — `/assets/` cache-first (hash do Vite), navegações network-first com shell cacheado como fallback offline, **nada de API** (cross-origin ignorado + `/api/` skip); `push` → `showNotification` (payload acima); `notificationclick` → foca janela existente + `navigate(url)`, senão `openWindow`. Registrado no boot do `main.tsx` (dev incluído — push testável em localhost). `manifest.webmanifest`: standalone, pt-BR, ícones 192/512 + maskable 512.
- **Ícones:** `public/icon.svg` = master pixel-art (balão de fala crimson com prompt `>_`, família visual dos stickers; **borda desenhada com rects** — o renderer SVG do ImageMagick ignora stroke) → PNGs via `magick` (comandos comentados dentro do SVG); `icon-maskable.svg` = sem moldura, arte a 75% (safe zone). favicon de template Vite removido; `index.html` ganhou manifest + apple-touch-icon + `theme-color` light/dark (**hex literal** — meta tag não lê CSS var; desvio consciente da regra "hex só em palettes.css").
- **Opt-in:** botão `notif on/off` no header da lista (`usePush` + `lib/push.ts`): `unsupported` → botão nem renderiza (iOS Safari em aba normal cai aqui), `denied` → disabled com title, `unavailable` = worker sem VAPID (503). Subscription **só** nasce do toggle (critério "sem opt-in" garantido por construção). **Logout chama `disablePush()` antes de `api.logout()`** — próxima conta no mesmo browser não recebe push da anterior. Edge aceito: a subscription do browser pertence à última conta que ligou o toggle.
- **Teste:** `npm run smoke:phase8` — **21 checks all green**, idempotente. Parte A (sem servidor): fetch global mockado, envia com a lib e **decripta o corpo por RFC 8291 no script** (ECDH+HKDF+AES-GCM) → JSON byte-idêntico; headers aes128gcm/`vapid t=,k=`/ttl/urgency/topic; 410 → `false`. Parte B: REST completo (shape da key, 401/400, SSRF http→400, upsert, isolamento entre users, idempotência). Parte C: **par dedicado `smoke8_ana`/`smoke8_ben`** (alice/bob podem ter socket vivo no browser do dev, o que colocaria o peer online e silenciaria o push) — mensagem pra peer offline entrega `sent` com o branch de push ativo, e a linha sobrevive a falha de rede (só 404/410 podam).
- **E2E Chrome real:** SW `activated`, manifest servido, botão ok nos dois temas, console limpo, clique dispara o prompt de permissão. **Prompt é UI do browser — a automação não alcança**; e2e completo da notificação = 1 clique manual em "Permitir" e mandar mensagem com a aba fechada (o wrangler dev alcança o FCM real de localhost). Fica como verificação manual pendente.
- **Suporte por browser (task 3):** Chrome/Edge/Firefox/Opera/Samsung Internet — push com payload ok. Safari macOS 13+ (Safari 16+) — ok. **iOS 16.4+: só PWA instalada na home screen** (Compartilhar → Adicionar à Tela de Início); em aba normal não existe PushManager → nosso botão some sozinho. iOS/Safari 18.4+ tem Declarative Web Push — não usado (SW imperativo funciona nos dois). **UE/iOS: Apple removeu PWA standalone (DMA) → sem push.**
- **Critério "Lighthouse PWA pass" ajustado:** Google removeu a categoria PWA do Lighthouse (out/2025). Substituto verificado: manifest válido + SW ativo (e2e acima); install real = botão "Instalar GoodChat" na omnibox do Chrome (manual, junto do teste de notificação).

---

## Fora de escopo permanente (PRD §1.4 — não implementar nunca sem ordem)

Group chats · descoberta pública · voz/vídeo RTC · apps nativos · monetização. E2EE = pós-MVP (PRD fase 4), só com pedido explícito.

## Pendências acumuladas

- **B2 real (fase 6):** criar bucket público + application key + CORS rules (receita no `worker/.env.example`), preencher `.dev.vars`/secrets e `VITE_MEDIA_URL`; validar contra o B2 real que a assinatura de content-length/content-type rejeita bytes divergentes. **+ fase 7:** publicar o pack `stickers/v1/` no bucket (`b2 sync worker/assets/stickers b2://<bucket>/stickers`).
- **Domínio Cloudflare na frente do B2** (Bandwidth Alliance, egress grátis) — fase 6 serve via URL direta até existir DNS.
- **Retenção/cleanup de mídia** (PRD §5): keys já têm prefixo mensal `media/<yyyy-mm>/` pra facilitar.
- Lista de conversas não atualiza em tempo real (poll 15s) — fase 5.
- **Push e2e manual (fase 8):** clicar "Permitir" no prompt de notificação (automação não alcança UI do browser), mandar mensagem com a destinatária sem aba aberta → notificação real via FCM; testar "Instalar GoodChat" na omnibox; testar home-screen PWA no iOS quando houver deploy https.
- Edit/delete de mensagens (schema já tem `edited_at`/`deleted_at`) · E2EE (PRD fase 4) — só com pedido explícito.
