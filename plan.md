# GoodChat — Plano: a conta como unidade de leitura

Mesmo protocolo dos planos anteriores: **fases autocontidas**, feitas para rodar
com contexto limpo. Cada uma declara o que ler ao começar, o que entrega, e
termina com um handoff preenchido aqui dentro.

As fases são sequenciais a partir da 1 — a 0 é independente e pode ir primeiro
ou em paralelo.

---

## Por que

Hoje a unidade de leitura é o **dispositivo**. Cada navegador gera um par ECDH
próprio, a chave de conteúdo é embrulhada uma vez por aparelho, e um navegador
novo começa cego no histórico — aparece como
`[mensagem de antes deste dispositivo]`. Existe um repasse
(`request_keys`/`share_keys`), mas ele só funciona com outro aparelho **online e
na mesma conversa aberta**.

A decisão: a unidade de leitura passa a ser a **conta**. Uma pessoa loga em
qualquer lugar e vê as conversas dela, sem vincular nada, sem QR, sem repasse.

O que **não** muda, e é a razão de o plano ser este e não outro:

| quem | lê? |
| --- | --- |
| o dono da instância | **não** |
| a Cloudflare | **não** |
| a Cloudflare sob intimação | **não** |
| as contas na conversa | **sim** |

Isso só se sustenta se a senha **nunca chegar ao servidor de forma utilizável**.
É o que a fase 1 resolve, e é por isso que ela vem antes da criptografia.

### O que isso custa, explicitamente

1. **Senha fraca + dump do D1 = legível.** Sem HSM, a entropia da senha é o que
   segura brute force offline. Daí o mínimo de 12 e o medidor na fase 1.
2. **Perdeu a senha, perdeu o histórico.** Não existe recuperação, por
   construção. É o preço de não haver nada no servidor.
3. **Some o escopo de comprometimento.** Hoje um aparelho roubado vaza só o que
   ele endereçava; depois vaza a conta. Trade aceito.
4. **O servidor entrega o JS.** Um build malicioso poderia vazar a senha. Mesmo
   teto do Bitwarden e do Proton. Não invalida o desenho; está aqui para não ser
   descoberto depois como se fosse surpresa.

### Dependência não resolvida

`plan-e2ee-verification.md` fase 1 continua em aberto: **uma `CryptoKey`
não-extraível sobrevive ao structured clone do IndexedDB?** Era importante; agora
é bloqueante. `accountKeys.ts` (fase 2) usa exatamente essa técnica, e se a
resposta for não, a chave de conta não pode ficar não-extraível e o desenho muda.
**Responder antes de começar a fase 2.**

---

## Fase 0 — contas guest sem senha

Independente do resto. Pode ir primeiro; simplifica a fase 1, porque remove o
único caso em que o servidor conhece uma senha.

**Ler antes:** `worker/src/lib/accounts.ts`, `worker/src/routes/auth.ts`
(`createTempSession`, `logout`), `app/src/components/TempAccount.tsx`,
`app/src/components/PasswordCard.tsx`.

### O que muda

Guest hoje: TTL de 5h, senha gerada no servidor e mostrada uma vez, dá pra
relogar com ela. Guest depois:

- **3 horas** de TTL (`TEMP_ACCOUNT_TTL_HOURS`, `wrangler.jsonc:105`)
- **sem senha nenhuma.** `password_hash` fica NULL. Não há o que mostrar, não há
  o que guardar, não há relogin
- **logout apaga a conta na hora.** A rota `logout` passa a chamar
  `deleteAccountKeepingPeers` quando `is_temp`
- fechou a aba sem deslogar: o TTL de 3h pega, como hoje

### Por que isso deixa o desenho melhor, não pior

É a única exceção do plano inteiro. Sem senha, não existe segredo derivável pelo
servidor — então a chave da conta guest é gerada no navegador e **nunca sai
dele**, sem embrulho, sem linha no D1.

Guest volta a ser exatamente o modelo por-dispositivo, e ali ele está certo: um
guest tem um dispositivo só, por definição. Some da fase 4 a ressalva "guest é
estruturalmente mais fraco".

### Arquivos

| arquivo | o quê |
| --- | --- |
| `worker/wrangler.jsonc` | `TEMP_ACCOUNT_TTL_HOURS: "3"` |
| `worker/src/lib/accounts.ts` | `DEFAULT_TTL_HOURS = 3`; `createTempAccount` para de gerar senha |
| `worker/src/routes/auth.ts` | `createTempSession` não devolve `password`; `logout` apaga se `is_temp` |
| `app/src/components/PasswordCard.tsx` | some (só existia pro guest) |
| `app/src/components/TempAccount.tsx` | tira o cartão de credenciais, mantém o contador |
| `app/src/hooks/useSession.tsx` | logout de guest limpa IndexedDB também |

### Cuidados

- **Logout tem que apagar a chave local.** Senão sobra `CryptoKey` órfã no
  IndexedDB de uma conta que não existe mais. `wipeDeviceKey` já existe.
- **A conversa do peer sobrevive.** `deleteAccountKeepingPeers` já mantém o
  thread com lápide (`readonly`) quando o outro lado ainda existe. Nada a fazer,
  mas confirmar no smoke.
- **`smoke:phase10`** cobre guest hoje e vai quebrar: ele espera senha na
  resposta. Reescrever junto.

**Entrega:** guest de 3h, sem senha, apagado no logout.

**Handoff:** _(preencher ao concluir)_

---

## Fase 1 — a senha para de chegar no servidor

O alicerce. Nada de criptografia muda aqui; é só a autenticação.

**Ler antes:** `worker/src/lib/password.ts`, `worker/src/routes/auth.ts`,
`worker/src/lib/users.ts`, `app/src/hooks/useSession.tsx`,
`app/src/screens/LoginScreen.tsx`.

### O desenho

```
masterKey = PBKDF2-SHA256(senha, kdf_salt, 600_000)    ← só no navegador
authToken = PBKDF2-SHA256(masterKey, senha, 1)         ← vai pro servidor
wrapKey   = HKDF(masterKey, "goodchat/wrap/v1")        ← só no navegador (fase 2)
```

O servidor guarda `hashPassword(authToken)` — `lib/password.ts` intocado, só com
outra entrada. De `authToken` não se volta pra `masterKey`.

O cap de 100k iterações do Workers (documentado no `password.ts` como abaixo do
recomendado pela OWASP) **deixa de importar**: a derivação cara roda no
navegador, que não tem esse teto. 600k de verdade.

### `POST /api/auth/kdf`

O cliente precisa de `{salt, iterations}` **antes** de logar.

**Username desconhecido tem que devolver salt determinístico e falso** —
`HMAC(segredo_da_instância, username)`. Sem isso vira oráculo de enumeração de
contas, e o `burnPasswordTime` do login já toma exatamente esse cuidado pelo
motivo equivalente.

### Rotação forçada

O servidor não consegue calcular o novo hash sem o texto claro, então conta
existente não migra sozinha:

1. último login pelo caminho legado (texto claro, uma última vez)
2. sessão volta com `must_rotate: true`
3. cliente pede senha nova na hora, deriva tudo local
4. manda `auth_token` + salt; servidor grava e limpa a flag

A senha em claro passa pelo servidor **uma última vez por conta**. É inevitável e
está registrado aqui de propósito.

### Mínimo de senha

12 caracteres e um medidor de força, no cadastro e na troca.
`MIN_PASSWORD_LENGTH` em `lib/users.ts:19`. O medidor é cliente; a checagem de
tamanho é nos dois lados.

### Arquivos

| arquivo | o quê |
| --- | --- |
| `worker/migrations/0013_client_kdf.sql` | `kdf_salt`, `kdf_iterations`, `must_rotate` em `users` |
| `worker/src/routes/auth.ts` | `/kdf`, login por `auth_token`, rotação |
| `worker/src/lib/users.ts` | mínimo 12 |
| `worker/scripts/create-user.ts`, `seed.ts` | derivam do lado deles |
| `app/src/lib/kdf.ts` | **novo** — as três derivações |
| `app/src/hooks/useSession.tsx` | deriva antes de postar |
| `app/src/screens/LoginScreen.tsx` | medidor, tela de rotação |

**Entrega:** ninguém consegue derivar `wrapKey` a partir do que o servidor
guarda ou vê passar.

**Handoff:** _(preencher ao concluir)_

---

## Fase 2 — a chave de conta

**Ler antes:** `app/src/lib/deviceKeys.ts`, `app/src/lib/e2ee.ts`,
`plan-e2ee-verification.md` fase 1 (a dependência acima).

Par ECDH P-256 por conta. Privada embrulhada em AES-GCM sob a `wrapKey`.

```sql
-- migration 0014
ALTER TABLE users ADD COLUMN account_public_key  TEXT;
ALTER TABLE users ADD COLUMN account_key_wrapped TEXT;
ALTER TABLE users ADD COLUMN account_key_iv      TEXT;
```

Gerada no cliente, no cadastro ou na rotação. O worker recebe os três campos
prontos e nunca vê a privada.

ECDH e **não** ECDSA: a chave embrulha chave de conteúdo. Não precisa assinar
nada, porque deixa de existir lista de dispositivos pra envenenar.

`deviceKeys.ts` → `accountKeys.ts`. Quase a mesma forma: `CryptoKey`
não-extraível em IndexedDB, escrita no login depois de desembrulhar. Mesmo
modelo de ameaça de hoje — o que muda é de onde ela vem.

**Entrega:** login em navegador zerado devolve a chave da conta.

**Handoff:** _(preencher ao concluir)_

---

## Fase 3 — o envelope encolhe

**Ler antes:** `worker/src/protocol.ts`, `worker/src/agent.ts`,
`app/src/lib/e2ee.ts`, `app/src/hooks/useConversation.ts`.

`v: 3` no `EncEnvelopeSchema`: `keys` passa de `{[device_id]: {iv, ct, via?}}`
para `{[user_id]: {iv, ct}}`. Duas entradas, sempre.

`sender_device` sai — o ECDH roda contra a chave pública da **conta** do
remetente, e o `messageAad` já amarra conversa + conta + client_id.

`v:1` e `v:2` aceitos por 7 dias, e o `protocol.ts` já tem esse precedente
escrito para o `v:2`. Depois some.

### O que isso apaga

| onde | o quê |
| --- | --- |
| `protocol.ts` | `request_keys`, `share_keys`, `keys_requested`, `keys_shared` |
| `agent.ts` | `handleRequestKeys`, `handleShareKeys`, `deviceBelongsTo`, `unaddressedDevices`, erro `stale_directory` |
| `e2ee.ts` | `rewrapFor`, `unwrapsVia`, `isAddressedTo`, `devicesFingerprint` |
| `useConversation.ts` | `askedForKeysRef`, `shareKeysWith`, `dismissKeyRequest`, todo o `resealPending` |
| `ThreadScreen.tsx` | banner "um aparelho novo da sua conta pediu esta conversa" |
| `lib/deviceDirectory.ts` | vira diretório de chave de conta, bem menor |
| `routes/devices.ts` + migration 0012 | reduzido a assinatura de push |

Apaga mais do que adiciona.

### Número de segurança

`safetyNumber(minhaContaPub, contaDelaPub)`. **Estável para sempre** — confere
uma vez na vida. A distinção `new-device` / `since-verified` do `ThreadScreen`
colapsa num alarme só, que passa a ser raro e a significar de verdade "a chave
mudou".

### Push

`sw.js:261` lê a chave do IndexedDB — passa a ler a da conta, mesmo caminho.
`push_subscriptions.device_id` vira id de assinatura, não de identidade.

**Entrega:** `[mensagem de antes deste dispositivo]` deixa de existir.

**Handoff:** _(preencher ao concluir)_

---

## Fase 4 — troca de senha e reset pelo dono

**Ler antes:** `worker/src/routes/auth.ts` (`changePassword`),
`worker/src/routes/admin.ts:321-395`.

### Troca pela própria pessoa

Cliente desembrulha com a `wrapKey` velha, reembrulha com a nova, manda
`{auth_token_novo, wrapped_novo, iv_novo, salt_novo}` mais o `auth_token` velho
para verificação. Servidor troca atomicamente. **Histórico preservado.**

### Reset pelo dono

O dono **não consegue** reembrulhar — não desembrulha. Então
`account_key_wrapped = NULL`, e a pessoa gera par novo no próximo login.

Consequência: **perde todo o histórico**, inclusive o que o peer mandou (estava
embrulhado para a chave antiga). A retenção limpa o resto em ≤7 dias.

Isso precisa aparecer:
- no diálogo de confirmação do console, antes de o dono clicar
- na trilha de auditoria — `user.password_reset` já existe, o texto muda

**Entrega:** trocar senha não perde nada; reset pelo dono perde tudo e avisa
antes.

**Handoff:** _(preencher ao concluir)_

---

## Fase 5 — provas e documentação

### `smoke:phase17` (novo)

O que precisa ser provado, e não dá para provar em nenhuma fase anterior:

1. o worker nunca recebe nada de que a `wrapKey` derive — inspeciona o corpo de
   toda requisição de login e troca de senha
2. um dump do D1 mais o `auth_token` **não** desembrulha a chave da conta
3. "segundo dispositivo" — store de chaves zerado, loga com a senha, lê o
   histórico inteiro
4. `/api/auth/kdf` devolve salt para username inexistente, e o mesmo salt duas
   vezes (determinístico, não aleatório)

### Reescritos

- `smoke:phase15` e `16` — envelope por conta. As duas implementações
  independentes continuam sendo o que garante o formato, e é o único lugar onde
  isso é verificado de fora
- `smoke:phase10` — guest sem senha (já tocado na fase 0)

### Docs

`.harness/prd.md`, `docs/architecture.md`, `README.md`. O README **promete
E2EE ao usuário**; o texto muda de "por dispositivo" para "por conta", e as três
consequências do topo deste arquivo entram em algum lugar visível.

**Handoff:** _(preencher ao concluir)_

---

## Ordem de commits

```
feat(worker)!: let a guest account live three hours without a password
feat(worker)!: derive the login secret on the client, never on the server
feat(app)!: hold one key per account, wrapped under the password
feat(worker)!: address envelopes to accounts instead of devices
refactor: delete the device handover the account key replaced
feat(app): re-wrap on password change, and say what an owner reset costs
test: prove the server cannot unwrap what it stores
docs(e2ee): the account is the unit of read access now
```

---

## Riscos

1. **Dia da virada.** Toda conta existente é forçada a rotacionar. Instância
   pequena e fechada, então é gerenciável — mas é um corte, não uma migração
   silenciosa.
2. **Perdeu a senha, perdeu o histórico.** Sem caminho de recuperação, por
   construção.
3. **`/kdf` é oráculo de enumeração** se feito ingênuo. O salt falso
   determinístico é obrigatório, não opcional.
4. **Perde-se o escopo de comprometimento.** Aparelho roubado passa a vazar a
   conta, não só o que aquele aparelho endereçava.
5. **A dependência do IndexedDB** (`plan-e2ee-verification.md` fase 1) bloqueia
   a fase 2 e ninguém respondeu ainda.

## Fora de escopo

- vinculação por QR, transferência de histórico entre aparelhos — a chave de
  conta torna as duas desnecessárias
- chave de conta que **assina** dispositivos — foi considerada e descartada:
  sem lista de dispositivos, não há o que assinar
- backup/escrow no servidor em qualquer forma — é exatamente o que este plano
  existe para não ter
