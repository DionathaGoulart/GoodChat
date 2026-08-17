# GoodChat — Guia de Deploy (do zero ao online)

Tudo que falta pra tirar o GoodChat do `localhost` e deixar rodando em produção,
na ordem certa. Hoje **nada está no ar**: sem remote no git, Worker nunca
deployado (`database_id` é placeholder), B2 real não existe (dev usa stub fake),
push usa chaves VAPID de dev.

> **Custo esperado: R$ 0.** Tudo cabe no free tier (Cloudflare Workers + DO
> SQLite + D1, Backblaze B2 10GB). Limites no §10.

---

## 0. Arquitetura final recomendada

```
Browser ──https──▶ Worker Cloudflare (goodchat-worker.<você>.workers.dev)
                    ├── /api/*  → API REST + upgrade WebSocket → Durable Objects
                    ├── /*      → SPA (Vite build servido como static assets)
                    ├── D1 (users, sessions, conversations, push_subscriptions)
                    └── push → FCM / Mozilla / Apple (VAPID)
Browser ──PUT/GET──▶ Backblaze B2 (bucket público goodchat-media)
```

**Por que o SPA dentro do Worker (e não Pages/Vercel):** o cookie de sessão é
`SameSite=Strict`. Frontend em `*.pages.dev` (ou Vercel) + API em
`*.workers.dev` são **sites diferentes** → o browser nunca envia o cookie →
login quebra. Em `localhost` funciona porque porta não conta pra SameSite.
Mesma origem resolve isso e ainda elimina CORS e configuração de URL da API.
(Alternativa com domínio próprio no §9.)

---

## 1. Pré-requisitos

- [x] Conta Cloudflare logada no wrangler (`npx wrangler whoami` — já está)
- [ ] Conta Backblaze B2 (criar em backblaze.com — free 10GB)
- [ ] `b2` CLI pros stickers: `brew install b2-tools`
- [x] Node ≥ 24, repo com fases 1–8 completas

---

## 2. Ajustes de código (uma vez, antes do 1º deploy)

Três mudanças pequenas que o código atual **ainda não tem** — ele assume
frontend e API em origens separadas, o que o cookie Strict não permite:

### 2.1 `worker/wrangler.jsonc` — servir o SPA como assets

```jsonc
{
  // ... configuração existente ...
  "assets": {
    "directory": "../app/dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  }
}
```

`run_worker_first` garante que `/api/*` (inclusive o upgrade WebSocket) chega
no código do Worker; todo o resto serve o build do Vite, com fallback SPA.
Depois de editar: `npm run cf-typegen` (regenerar types).

### 2.2 `app/src/lib/api.ts` — API relativa quando mesma origem

`VITE_API_URL` vazio deve significar "mesma origem". O `fetch` já aceita path
relativo, mas o `wsUrl()` precisa de base absoluta:

```ts
export function wsUrl(conversationId: string, otherUserId: string): string {
  const base = API_URL !== '' ? API_URL : window.location.origin
  return `${base.replace(/^http/, 'ws')}/api/ws/${conversationId}?with=${encodeURIComponent(otherUserId)}`
}
```

### 2.3 `app/.env.production` (novo arquivo, commitável — sem segredos)

```bash
VITE_API_URL=
VITE_MEDIA_URL=https://<sua URL pública do B2, ver §4>
```

O Vite usa esse arquivo automaticamente no `npm run build`.

> Esses três ajustes o Claude aplica em minutos se você pedir — ou faça na mão
> seguindo o de cima.

---

## 3. Banco (D1 remoto)

```bash
cd worker

# 1. Criar o banco real
npx wrangler d1 create goodchat
# → copie o database_id impresso e cole no wrangler.jsonc
#   (substituindo o placeholder 00000000-...)

# 2. Aplicar as migrations no remoto
npx wrangler d1 migrations apply goodchat --remote
```

### Criar usuários no banco remoto

Os scripts `db:seed` / `user:create` só falam com o banco **local**. Receita
pro remoto (o hash PBKDF2 é portátil):

```bash
# 1. Criar o usuário localmente
npm run user:create -- rafael minha-senha-forte "Rafael"

# 2. Copiar a linha gerada
npx wrangler d1 execute goodchat --local --command \
  "SELECT id, username, display_name, password_hash, created_at FROM users WHERE username='rafael'"

# 3. Inserir no remoto com os valores copiados
npx wrangler d1 execute goodchat --remote --command \
  "INSERT INTO users (id, username, display_name, avatar_url, password_hash, created_at) VALUES ('<id>', 'rafael', 'Rafael', NULL, '<password_hash>', <created_at>)"
```

**Não** semeie `alice`/`bob` em produção — são fixtures de dev com senha
pública no repo.

---

## 4. Mídia (Backblaze B2)

Receita completa também em `worker/.env.example`. Resumo:

1. **Bucket**: `b2 bucket create goodchat-media allPublic` (ou pela UI —
   *Files públicos*).
2. **Application key** escopada:
   `b2 key create --bucket goodchat-media goodchat-worker listBuckets,readFiles,writeFiles`
   → guarde `keyID` e `applicationKey` (aparecem uma vez só).
3. **CORS no bucket** (UI → Bucket Settings → CORS Rules): permitir todas as
   origens, operações S3 `s3_put` + `s3_get`, header `content-type`. Sem isso o
   PUT do browser falha.
4. **Endpoint S3**: aparece na UI do bucket, ex.
   `https://s3.us-west-004.backblazeb2.com`.
5. **URL pública**: `https://f004.backblazeb2.com/file/goodchat-media`
   (o `f00X` casa com a região do endpoint). É esse valor que vai em
   `B2_PUBLIC_BASE_URL` **e** em `VITE_MEDIA_URL` (§2.3) — têm que ser iguais.
6. **Publicar os stickers** (bucket real só aceita PUT assinado):

   ```bash
   b2 sync worker/assets/stickers b2://goodchat-media/stickers
   ```

7. **Validar** (pendência da fase 6, nunca testada contra B2 real): depois do
   deploy, subir uma imagem pelo app e conferir que chega; tentar um PUT com
   tamanho diferente do assinado e conferir que o B2 rejeita.

> **Alternativa: Cloudflare R2.** O código de presign é S3 genérico
> (`aws4fetch`) — R2 funciona com as mesmas cinco envs (endpoint
> `https://<account_id>.r2.cloudflarestorage.com`, domínio público do bucket
> como base URL). Vantagem: tudo numa conta só, egress grátis nativo. O PRD
> escolheu B2; trocar é decisão sua, não exige mudança de código.

---

## 5. Push (VAPID de produção)

**Gere um par novo** — as chaves em `.dev.vars` são de desenvolvimento.
Rotacionar chave depois mata todas as inscrições, então gere uma vez e guarde:

```bash
cd worker
npm run vapid:generate
```

Guarde a saída. O subject deve ser um contato real, ex.
`mailto:dgoulart.work@gmail.com`.

---

## 6. Secrets e vars do Worker

Segredos via CLI (nunca no git):

```bash
cd worker
npx wrangler secret put B2_KEY_ID           # keyID do §4
npx wrangler secret put B2_APPLICATION_KEY  # applicationKey do §4
npx wrangler secret put VAPID_PRIVATE_KEY   # do §5
```

Não-segredos podem ir no `wrangler.jsonc` (commitável):

```jsonc
"vars": {
  "B2_BUCKET_NAME": "goodchat-media",
  "B2_S3_ENDPOINT": "https://s3.us-west-004.backblazeb2.com",
  "B2_PUBLIC_BASE_URL": "https://f004.backblazeb2.com/file/goodchat-media",
  "VAPID_PUBLIC_KEY": "<público do §5>",
  "VAPID_SUBJECT": "mailto:dgoulart.work@gmail.com"
}
```

Depois: `npm run cf-typegen`.

> Atenção: `vars` do wrangler.jsonc **não** valem no dev local (lá manda o
> `.dev.vars`). São dois mundos separados — é o desenho esperado.

---

## 7. Build + deploy

```bash
# 1. Build do frontend (gera app/dist, que o Worker serve como assets)
cd app && npm run build

# 2. Deploy (sobe Worker + assets + migration do DO junto)
cd ../worker && npm run deploy
```

Primeira vez: o wrangler pergunta se ativa o subdomínio `workers.dev` — sim.
URL final: `https://goodchat-worker.<seu-subdominio>.workers.dev`.

**Redeploys futuros**: sempre os dois passos nessa ordem (build → deploy).
Vale criar um atalho no `worker/package.json`:

```json
"deploy:full": "cd ../app && npm run build && cd ../worker && wrangler deploy"
```

---

## 8. Checklist pós-deploy

Na URL de produção, em ordem:

- [ ] `GET /api/health` responde `{"ok":true}`
- [ ] SPA carrega na raiz, tema retro ok em light e dark
- [ ] Login com o usuário criado no §3 (cookie `Secure` agora em https de verdade)
- [ ] Dois browsers/perfis logados conversam em tempo real (WebSocket `wss://`)
- [ ] Refresh mantém sessão e histórico; mensagem offline chega na reconexão
- [ ] Upload de imagem: aparece no outro lado, sobrevive a reload, lightbox abre
- [ ] Stickers carregam (manifest + SVGs vindos do B2)
- [ ] **Push** (agora dá pra testar de ponta a ponta): `notif off` → **Permitir**
      no prompt → fechar a aba → mandar mensagem do outro usuário → notificação
      aparece; clique abre a thread certa
- [ ] **PWA**: ícone de instalar na omnibox do Chrome → instala como janela própria
- [ ] iOS (se tiver iPhone): Safari → Compartilhar → Adicionar à Tela de Início →
      abrir o app instalado → ativar notificações (iOS 16.4+, fora da UE)
- [ ] `npx wrangler tail` num terminal enquanto testa — zero erro nos logs

---

## 9. Opcional: domínio próprio

Sem domínio tudo funciona no `workers.dev`. Com domínio no Cloudflare você ganha:

1. **URL bonita**: `wrangler.jsonc` →
   `"routes": [{ "pattern": "chat.seudominio.com", "custom_domain": true }]`.
2. **Mídia com egress grátis** (Bandwidth Alliance, pendência da fase 6):
   CNAME `media.seudominio.com` → `f004.backblazeb2.com` (proxy laranja ligado),
   e troque `B2_PUBLIC_BASE_URL`/`VITE_MEDIA_URL` para
   `https://media.seudominio.com/file/goodchat-media`. Sem isso o egress sai da
   franquia da B2 (grátis até 3× o storage médio/dia — suficiente pra instância
   pequena).

---

## 10. Operação, limites e manutenção

| Recurso | Free tier (por dia, salvo nota) | Observação |
|---|---|---|
| Worker requests | 100k | inclui requests de assets |
| Durable Objects (SQLite) | 100k requests, 13k GiB-s | hibernation ligada = idle custa zero |
| D1 | 5M leituras, 100k escritas, 5GB total | sessions/receipts são a maior carga |
| B2 | 10GB storage, egress 3×storage/dia | proxy Cloudflare zera egress (§9) |
| Web Push | grátis | FCM/Mozilla/Apple não cobram |

- **Logs ao vivo**: `cd worker && npx wrangler tail` (observability já ligada).
- **Migrations futuras**: criar arquivo em `worker/migrations/`, aplicar
  `--local` pra dev e `--remote` pra prod.
- **Rotação de secrets B2**: gerar key nova na B2 → `wrangler secret put` de
  novo → deploy. Sem downtime.
- **Rotação VAPID**: evitar — invalida todas as inscrições (usuários precisam
  reativar o toggle). O client já se recupera sozinho (re-subscribe), mas só no
  próximo toggle.
- **Rollback**: `npx wrangler rollback` volta pro deploy anterior.

---

## 11. O que ainda falta / riscos conhecidos (estado 2026-08-17)

**Bloqueia o deploy (fazer antes):**
1. Ajustes de código do §2 (assets + wsUrl + .env.production) — **sem isso o
   login não funciona em produção** (cookie SameSite=Strict cross-site).
2. `database_id` real no wrangler.jsonc (§3).
3. Bucket B2 + CORS + stickers publicados (§4) — sem isso mídia/stickers dão erro
   (texto e emoji funcionam mesmo assim).
4. VAPID de produção + secrets (§5–6) — sem isso push responde 503 e o botão
   mostra "push não configurado"; resto do app funciona.

**Não bloqueia, mas está pendente:**
5. Validação da assinatura content-length/type contra B2 real (fase 6).
6. Retenção/cleanup de mídia — nunca implementado; keys já têm prefixo mensal
   (`media/<yyyy-mm>/`) pra facilitar um cron futuro.
7. Lista de conversas não atualiza em tempo real (poll de 15s — dívida fase 5).
8. Rate limit só existe no login; lookup/subscribe/etc contam com sessão apenas
   (aceito na fase 3 pra instância pequena).
9. Scripts de seed/criação de usuário são local-only (receita manual no §3;
   dá pra adicionar flag `--remote` neles se for criar contas com frequência).
10. Sem CI/CD — deploy é manual (§7). Opcional: conectar o repo no GitHub +
    Workers Builds pra deploy automático no push.
11. Sem backup automatizado do D1 — `npx wrangler d1 export goodchat --remote`
    de vez em quando resolve pra instância pequena (Time Travel do D1 cobre
    30 dias de point-in-time restore).
12. E2EE, edit/delete de mensagens, grupos — fora de escopo por decisão
    (PRD §1.4), não são pendência.
