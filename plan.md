# GoodChat — Plano: a conta como unidade de leitura

Mesmo protocolo dos planos anteriores: **fases autocontidas**, feitas para rodar
com contexto limpo. Cada uma declara o que ler ao começar, o que entrega, e
termina com um handoff preenchido aqui dentro.

As fases são sequenciais a partir da 1 — a 0 é independente e pode ir primeiro ou
em paralelo. A 6 é manual, precisa de navegador, e fecha o conjunto.

Funde o antigo `plan.md` de verificação criptográfica: a fase 17 dele já estava
executada e virou a evidência citada abaixo; a 18, nunca executada, virou a fase
6 daqui, reescrita porque três dos doze passos dela descreviam comportamento que
este plano apaga.

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

### A premissa que sustenta a fase 2, e já foi medida

`accountKeys.ts` guarda a chave da conta como `CryptoKey` não-extraível no
IndexedDB — a mesma técnica do `deviceKeys.ts` de hoje. Isso depende de o
structured clone preservar a não-extratibilidade, o que nenhum teste em Node
responde.

**Já foi respondido: sim.** Medido em 2026-08-20, Chrome 151 em macOS, contra a
stack local, conta `alice`:

- lida de volta pelo próprio módulo: `privateKey instanceof CryptoKey` → `true`;
  `.extractable` → `false`; `.type` → `'private'`; `.algorithm.name` → `'ECDH'`
  (`namedCurve: 'P-256'`, `usages: ['deriveBits']`)
- `exportKey` rejeita nos três formatos (`raw`, `pkcs8`, `jwk`) com
  `InvalidAccessError: key is not extractable`
- `deriveBits` com a chave **lida do IndexedDB** (não a recém-gerada) devolve 32
  bytes estáveis, e o segredo bate com o derivado no sentido inverso — privada do
  par × pública publicada. Ou seja: a chave guardada é a que o diretório anuncia
- reload mantém o id; logout esvazia a object store; outra conta no mesmo
  navegador não vê nada da anterior

Nada a fazer. Está registrado porque é a premissa de que a fase 2 depende, e quem
retomar isto com contexto limpo vai querer saber que ela foi medida e não
presumida.

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

**Handoff:** feito. `password_hash` fica NULL — não é um hash de algo
inadivinhável, é ausência, e é por isso que "não dá pra voltar nessa conta"
passa a ser propriedade do schema e não de um segredo. `logout` agora resolve a
sessão antes de revogá-la e chama `deleteAccountKeepingPeers` quando `is_temp`;
falha ali é logada e engolida, porque o sweep do TTL é o backstop e sair não
pode falhar por causa da limpeza.

Uma correção à tabela desta fase: **`PasswordCard.tsx` não some.** Ele é o card
de *trocar* senha da tela de config e já retorna `null` para guest
(`if (!user || user.is_temp) return null`) — quem só existia pro guest era o
`GuestCredentialsCard` de `TempAccount.tsx`, e foi esse que foi removido, junto
com `guestCredentials`/`forgetGuestCredentials` no `useSession` e com o campo
`password` em `TempAccountResult`. A fase 4 depende do `PasswordCard`.

`smoke:phase10` reescrito: TTL de ~3h, ausência de senha checada em três
lugares (corpo da resposta, `password_hash` no D1, e o login recusando), e o
logout apagando a conta. O teste do logout roda no *terceiro* convidado em vez
de criar um quinto — a quarta criação existe para provar a quota por IP, e criar
mais uma ali mediria a quota, não o logout.

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

**Handoff:** feito, e verificado contra a stack local — `/kdf` devolve salt
determinístico para nome inexistente, login derivado numa conta legada dá 401,
o fallback legado devolve `must_rotate: true`, `/rotate` grava, e depois a senha
antiga para de funcionar.

**A decisão de desenho que o plano deixava em aberto: como o cliente descobre
que a conta é legada.** Não descobre — ele tenta. `/kdf` responde com um salt
para *qualquer* nome: real para conta rotacionada, decoy HMAC para
inexistente **e para legada**, na mesma forma. O cliente deriva, tenta com
`auth_token`, e só depois de `invalid_credentials` manda a senha. Isso é o que
mantém o par de requisições idêntico entre "conta não existe" e "senha errada"
— qualquer desenho em que `/kdf` dissesse o formato responderia "essa conta
existe" de graça. O custo é que uma tentativa derivada que falha é seguida da
senha em claro; aceitável exatamente porque falhou (uma senha que não abre a
conta não diz nada sobre ela). O caso em que custa algo — digitar a senha de
*outra* conta da mesma instância — está escrito na rota.

Outra consequência do mesmo ordenamento, também anotada em `login`: um sign-in
legado gasta um slot de falha antes de acertar. Zera no sucesso; só morde uma
conta já em quatro falhas, e acaba quando ela rotaciona.

**Além do que a tabela previa:**

- `changePassword` **também** virou derivada nesta fase, não na 4. Não dava pra
  adiar: ela grava `password_hash` e, se continuasse gravando hash de texto
  claro, deixaria a conta com `kdf_salt` descrevendo um hash que não é mais o
  dela — uma conta em que ninguém entra. A fase 4 acrescenta o reembrulho da
  chave por cima da mesma chamada.
- `POST /api/admin/users` e o reset do dono gravam
  `kdf_salt = NULL, kdf_iterations = NULL, must_rotate = 1` junto com o hash. É
  o invariante: senha que o servidor escolheu é senha que o servidor sabe.
  Achei um bug ao fazer isso — os placeholders do `UPDATE` eram numerados por
  `sets.length`, e três atribuições literais (`= NULL`, `= 1`) desalinhariam o
  `WHERE`. Passou a numerar por `bindings.length`.
- `worker/scripts/lib.ts` importa `app/src/lib/kdf.ts` atravessando a fronteira
  do workspace (Node 24 resolve `.ts` direto; `smoke-phase16.ts` já fazia isso
  com `e2ee.ts`). Tem que ser **uma** implementação: um CLI que hasheasse do
  jeito antigo criaria uma conta em que o navegador não entra. `user:create`
  agora nasce já em v2, sem tela de rotação.
- Todas as smokes que logavam com senha passaram a usar `signIn` do `lib.ts`,
  que faz o mesmo par de requisições do app, **incluindo o fallback legado** —
  senão o teste estaria exercitando um caminho que o app não usa.
- `KDF_DECOY_SALT` novo (cai em `RATE_LIMIT_SALT`, e depois numa constante),
  declarado em `.dev.vars`, `.env.example` e `worker-configuration.d.ts`.
- O mínimo de 12 no servidor só vale onde o servidor ainda vê senha: console do
  dono e CLI. Nos caminhos derivados ele recebe um token de tamanho fixo e não
  tem o que medir — `MIN_PASSWORD_LENGTH` em `app/src/lib/kdf.ts` é a regra
  inteira ali, e isso está escrito nos dois arquivos.

Fixtures de dev rotacionadas para v2 com as mesmas senhas documentadas
(`alice-goodchat`, `bob-goodchat`, `good-goodchat`). Smokes 4, 6, 7, 8, 9, 10,
11, 12, 13, 14, 15 e 16 verdes. A 3 falha em `exists=false` por estado
acumulado no D1 local — o mesmo aviso que a fase 6 dá.

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

## Fase 6 — a conversa de ponta a ponta, no navegador

Herdada do plano de verificação anterior (fase 18, nunca executada) e reescrita
para o desenho por conta. Existe separada das smokes porque precisa de navegador:
nenhum teste em Node exercita a fiação React nem o IndexedDB.

**Ler antes:** `app/src/hooks/useConversation.ts` (`toThread`, `seal`,
`sendEvent`, a fila `frameQueue`), `app/src/components/MessageBubble.tsx`
(`useMediaSource`), `app/src/screens/ConversationsScreen.tsx` (`openPreviews`),
`app/src/screens/ThreadScreen.tsx`, `app/src/components/SafetyNumber.tsx`.

### Subir a stack

```bash
cd worker && npm run db:migrate && npm run db:seed
node scripts/create-user.ts --owner good good-goodchat Good
npm run dev            # :8000
npm run media:dev      # :9000  (outro terminal)
npm run stickers:publish
cd ../app && npm run dev   # :5173
```

O D1 local acumula estado entre execuções. Antes de afirmar qualquer coisa da
forma "ainda não existe", apague `worker/.wrangler/state` e refaça o seed — foi o
que fez a `smoke:phase3` falhar três vezes por motivo nenhum.

### Passos

Dois perfis do navegador, `alice` e `bob`, conversando.

1. **Texto.** Mandar dos dois lados. Cadeado fechado 🔒 no cabeçalho, sem faixa de
   aviso, texto legível nas duas telas.
2. **Não confiar na tela.** Confirmar no servidor que o guardado é ciphertext —
   DevTools → Network → WS, frame `history`. Nenhum trecho do que foi digitado
   pode aparecer. Este passo e o 4 são os únicos que provam a propriedade; o
   resto prova a usabilidade.
3. **Emoji e sticker.** Sticker tem que renderizar a arte, não `[sticker]` — é o
   caminho onde o id sai do ciphertext e passa pelo `STICKER_ID_RE` no
   destinatário.
4. **Imagem.** Bolha renderiza; e `GET /api/media/<key>` com o cookie de sessão,
   fora do app, tem que devolver bytes ilegíveis.
5. **Vídeo.** Confirmar que toca — e que a espera é o download inteiro, que é a
   regressão conhecida e documentada.
6. **Previews da lista.** Voltar para `#/`: o tile mostra o texto da última
   mensagem, não `[mensagem cifrada]` nem base64.
7. **Recarregar dentro da thread.** O cache local não serializa `CryptoKey`,
   então a mídia mostra esqueleto e resolve quando o `history` chega — nunca
   "[mídia indisponível]".
8. **Segundo dispositivo — o passo que inverteu.** Entrar como `alice` num
   terceiro perfil, com IndexedDB zerado. **Todo o histórico tem que abrir**,
   não só as mensagens novas. No desenho antigo o esperado aqui era
   `[mensagem de antes deste dispositivo]`; agora esse placeholder não pode
   aparecer em lugar nenhum. É a prova da fase 3.
9. **Safety number.** Abrir o 🔒 nos dois lados e comparar: idênticos, 12 grupos
   de 5 dígitos. Depois abrir num terceiro navegador da mesma conta — **tem que
   ser o mesmo número**, porque agora deriva da chave da conta e não do conjunto
   de aparelhos. É a outra metade da prova da fase 3.
10. **Troca de chave de verdade.** Reset de senha pelo dono numa das contas.
    Do outro lado, a faixa de chave trocada tem que aparecer — e a conta
    resetada tem que perder o histórico, como a fase 4 promete.
11. **Push com preview.** Ativar notificações, `push_preview` em "mostrar
    trecho", mandar com a aba fechada: a notificação mostra o texto — e o log do
    worker não contém nenhum trecho dele.
12. **Fechar a transição.** `E2EE_REQUIRED=true` no `.dev.vars`, reiniciar,
    mandar de um navegador sem chave: recusado com `encryption_required`
    visível, não engolido.

**Critérios de aceite:** os doze; nenhum erro no console; e os passos 2, 4, 8 e 9
são os que provam o que este plano inteiro existe para entregar.

**Handoff:** _(preencher ao concluir: navegadores e versões, o que apareceu nos
passos 2, 4, 8 e 9, e qualquer passo que precisou de retentativa)_

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

A fase 6 não gera commit: ela preenche o handoff acima.

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
5. **A fase 6 é manual e não repetível.** É a única prova de ponta a ponta do
   caminho criptográfico dentro de um navegador, e roda no braço. Automatizar com
   Playwright vale a pena, mas é decisão de escopo própria — dependência nova,
   tempo de CI, e um segundo lugar onde a criptografia passa a ser descrita.
   Anotar no handoff o que doeu manualmente: é a evidência para decidir depois.

## Fora de escopo

- vinculação por QR, transferência de histórico entre aparelhos — a chave de
  conta torna as duas desnecessárias
- chave de conta que **assina** dispositivos — foi considerada e descartada:
  sem lista de dispositivos, não há o que assinar
- backup/escrow no servidor em qualquer forma — é exatamente o que este plano
  existe para não ter

## Em aberto, e de produto — não de verificação

Registrado em `docs/architecture.md`, herdado do plano anterior e ainda válido:

- **sem forward secrecy** — ECDH estático; a janela de 7 dias é o que limita uma
  chave vazada. Com a regra de 3h após lida, na prática é bem menos
- **vídeo baixa inteiro antes de tocar** — AES-CTR mais MAC do objeto inteiro via
  Media Source Extensions seria a saída
- **avatares, nomes e presença seguem em texto claro**, porque são renderizados
  para contas com quem você nunca falou
