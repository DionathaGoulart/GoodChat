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
| 4 | Real-time core (DO + WebSocket) | ⬜ pendente |
| 5 | Frontend do chat | ⬜ pendente |
| 6 | Pipeline de mídia (B2) | ⬜ pendente |
| 7 | Receipts, typing, emoji, stickers | ⬜ pendente |
| 8 | PWA + push (stretch) | ⬜ pendente |

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

**Handoff:** _(Hibernation sim/não e API usada, formato de rota WS, N do histórico, como rodar o teste de integração, pegadinhas do Agents SDK)_

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

**Handoff:** _(árvore de componentes, hooks criados — useSession/useWebSocket, rotas, como rodar e2e manual, dívidas visuais)_

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

**Handoff:** _(nome do bucket, formato das keys de objeto, limites escolhidos, URL de serving usada, pendência do domínio CF se houver)_

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

**Handoff:** _(lib de emoji, formato do manifest de stickers, mudanças no protocolo se houve)_

---

## Fase 8 — PWA + push (stretch)

**Objetivo:** instalável + notificações com opt-in explícito.

**Ler antes:** `.harness/prd.md` §3.8, §7 fase 3; handoffs 5 e 7.

**Tarefas:**
1. Manifest + ícones (gerar no estilo retro) + service worker (cache estático mínimo, sem cache de API).
2. Web Push VAPID direto do Worker: tabela de subscriptions (D1), opt-in explícito na UI, push disparado pelo DO quando destinatário offline.
3. Verificar suporte atual de Web Push em iOS/Safari PWA e documentar limitações.

**Critérios de aceite:** app instala (Lighthouse PWA pass); com app fechado, mensagem gera notificação em browser suportado; sem opt-in → nenhuma subscription criada.

**Handoff:** _(estratégia do SW, tabela de subscriptions, suporte por browser)_

---

## Fora de escopo permanente (PRD §1.4 — não implementar nunca sem ordem)

Group chats · descoberta pública · voz/vídeo RTC · apps nativos · monetização. E2EE = pós-MVP (PRD fase 4), só com pedido explícito.

## Pendências acumuladas

_(fases anexam aqui itens adiados: retenção de mídia, domínio CF do B2, edit/delete, E2EE...)_
