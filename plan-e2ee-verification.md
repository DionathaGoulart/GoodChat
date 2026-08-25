# GoodChat — Plano de verificação do cliente criptográfico

Retomada do `plan.md` original, mesmo protocolo: fases autocontidas, feitas para
rodar com **contexto limpo**, cada uma declarando o que ler ao começar e
terminando com um handoff aqui dentro.

Duas fases, uma pergunta cada. Ambas precisam de navegador — é por isso que
existem separadas, e não como mais um `smoke:phaseN`.

---

## Contexto

O E2EE foi implementado e verificado até onde dá sem navegador:

| Camada | Como está coberta |
| --- | --- |
| Worker, envelope, mídia, diretório de chaves | `smoke:phase15` — uma **segunda implementação** do formato, escrita a partir do `docs/architecture.md`, conversando com o Worker de verdade |
| `app/src/lib/e2ee.ts` | `smoke:phase16` — o módulo real, cruzado com a implementação da phase 15 **nos dois sentidos** (o app abre o que a referência selou, e vice-versa) |
| `app/public/sw.js` | `smoke:phase16` — o arquivo avaliado num sandbox com os globais de worker, decifrando algo que o app selou |

Sobrou o que não roda em Node:

1. **`app/src/lib/deviceKeys.ts`** — o IndexedDB. Uma pergunta binária: uma
   `CryptoKey` não-extraível sobrevive ao structured clone? Se não, o app
   funciona perfeitamente e **não criptografa nada**.
2. **A fiação React** — `useConversation` (selar no envio, abrir na recepção, a
   fila serializada de frames), `MessageBubble` (fetch → decifra → object URL),
   `ConversationsScreen` (previews da lista).

O modo de falha silencioso que ligava as duas — mandar em texto claro sem avisar
— já foi fechado: `useConversation` reporta `encryption: 'unknown' | 'on' | 'off'`
calculado com exatamente as condições que o `seal` checa, e a thread mostra 🔓 e
a faixa "esta conversa não está criptografada". Então o que resta aqui é
**medir**, não blindar.

---

## Estado global

| Fase | Nome | Status |
| --- | --- | --- |
| 17 | A chave neste navegador | ✅ feita |
| 18 | A conversa de ponta a ponta | ⬜ pendente |

Pré-requisito das duas (subir a stack):

```bash
cd worker && npm run db:migrate && npm run db:seed
node scripts/create-user.ts --owner good good-goodchat Good
npm run dev            # :8000
npm run media:dev      # :9000  (outro terminal)
npm run stickers:publish
cd ../app && npm run dev   # :5173
```

O D1 local acumula estado entre execuções. Antes de afirmar qualquer coisa da
forma "ainda não existe", apague `worker/.wrangler/state` e refaça o seed — foi
o que fez a `smoke:phase3` falhar três vezes por motivo nenhum.

---

## Fase 17 — A chave neste navegador

**Objetivo:** responder a única pergunta que nenhum teste em Node responde, e
verificar o ciclo de vida da identidade: criação, registro, reuso, apagamento.

**Ler antes:** `app/src/lib/deviceKeys.ts` (inteiro), o efeito de registro e o
`forgetLocalState()` em `app/src/hooks/useSession.tsx`,
`worker/src/routes/devices.ts`, `worker/migrations/0012_devices.sql`.

**Tarefas:**

1. Subir a stack, abrir `http://localhost:5173`, entrar como `alice`.
2. DevTools → Application → IndexedDB → `goodchat-keys` → `identity`: deve haver
   **uma** linha, com a chave do registro sendo o id da conta.
3. **A pergunta que importa.** No console, ler a linha de volta pelo próprio
   módulo e checar os quatro predicados:
   ```js
   const id = await (await import('/src/lib/deviceKeys.ts')).readDeviceKey('<user id>')
   id.privateKey instanceof CryptoKey   // true
   id.privateKey.extractable            // false
   id.privateKey.type                   // 'private'
   id.privateKey.algorithm.name         // 'ECDH'
   ```
4. Confirmar que exportar **falha**: `crypto.subtle.exportKey('raw', id.privateKey)`
   tem que rejeitar. Se exportar, a chave não é o que o código afirma ser e a
   fase para aqui — é uma decisão de arquitetura, não um bug para corrigir na
   hora.
5. Confirmar que o uso real ainda funciona com a chave **lida de volta** (não a
   recém-gerada): um `deriveBits` de ECDH contra qualquer chave pública. É isso
   que o `sealMessage` faz em toda mensagem.
6. Recarregar a página: mesmo `id`, nenhuma linha nova em `devices` no D1 —
   só `last_seen_at` avança.
7. Conferir no D1 que o id da linha bate com o digest da chave pública
   (`SHA-256(public_key)` truncado a 32 hex), que é o que sustenta o safety
   number e o aviso de troca de chave.
8. Logout: a object store fica vazia. Entrar como `bob` no mesmo navegador: id
   novo, e nada da alice sobrou.
9. Janela anônima: entrar, abrir uma conversa e confirmar que aparece 🔓 e a
   faixa "esta conversa não está criptografada" — degradação visível, não
   silenciosa.

**Critérios de aceite:** os quatro predicados do passo 3; export rejeitado;
`deriveBits` funcionando com a chave lida do IndexedDB; id estável entre reloads;
store vazia após logout; modo anônimo degradando visivelmente.

**Não fazer:** não mexer em `deviceKeys.ts` para "consertar" nada antes de medir.
Se o clone não preservar a chave, a saída é trocar a estratégia de armazenamento
(chave derivada de senha, ou não-persistente por sessão) — decisão do usuário,
com tradeoffs próprios, não uma correção óbvia.

**Handoff:** Executada em 2026-08-20, Chrome 151.0.0.0 em macOS, contra a stack
local (worker `:8000`, media `:9000`, vite `:5173`), conta `alice`
(`ab1f5878-cbc3-41c5-9d0f-bede668f7aa4`).

- **Passo 2.** Uma linha em `goodchat-keys` → `identity`, com a chave do
  registro sendo o id da conta.
- **Passo 3 — a pergunta que importa.** Lida de volta pelo próprio módulo
  (`readDeviceKey`), os quatro predicados: `privateKey instanceof CryptoKey`
  → `true`; `.extractable` → `false`; `.type` → `'private'`;
  `.algorithm.name` → `'ECDH'` (com `namedCurve: 'P-256'` e
  `usages: ['deriveBits']`). **O structured clone preserva a chave
  não-extraível** — que era a única coisa que nenhum teste em Node responde, e
  a resposta é sim.
- **Passo 4.** `exportKey` rejeita nos três formatos (`raw`, `pkcs8`, `jwk`)
  com `InvalidAccessError: key is not extractable`.
- **Passo 5.** `deriveBits` com a chave **lida do IndexedDB** (não a
  recém-gerada) devolve 32 bytes e é estável entre chamadas; e o segredo bate
  com o derivado no sentido inverso — privada do par × pública publicada — o
  que prova que a chave guardada é a que o diretório anuncia, e não outra.
- **Passo 6.** Reload mantém o id `d7dab0ced04845e31cf0d922ec199345`, `devices`
  continua com as mesmas 7 linhas, `created_at` intacto e `last_seen_at`
  avançou 95s. (As outras 6 linhas são resíduo das smokes 15/16 no D1 local,
  não devices deste navegador — vale limpar antes da fase 18.)
- **Passo 7.** Os 7 ids da tabela batem com `SHA-256(chave pública crua)`
  truncado a 32 hex, incluindo o deste navegador.
- **Passo 8.** Logout esvazia a object store (0 linhas). `bob` no mesmo
  navegador gera `d46fea992c47ec39d711c64a27b4cd76` e a store fica só com a
  chave dele — nada da alice sobrou.
- **Passo 9 — com uma ressalva.** Foi medido **negando o IndexedDB**
  (`indexedDB.open` lançando `SecurityError`), não em janela anônima: a
  extensão que dirige o navegador não alcança o modo anônimo. A degradação é
  visível como o plano exige — 🔓 com
  `aria-label="esta conversa não está criptografada"` e a faixa amarela — e ao
  restaurar o banco volta para 🔒 "número de segurança desta conversa" sem
  faixa, ou seja, o indicador acompanha exatamente a presença da identidade.
  Fica registrado que **a premissa do passo está desatualizada**: o Chrome
  atual *dá* IndexedDB em janela anônima (em memória, morre com a janela), então
  o esperado ali é 🔒 com uma identidade efêmera registrando um device novo a
  cada janela. Quem dispara o caminho `!identity` não é o modo anônimo e sim um
  navegador que recusa o banco — que é o que foi exercitado.
- Nenhum erro no console do navegador.

---

## Fase 18 — A conversa de ponta a ponta

**Objetivo:** executar a fiação React que hoje só compila.

**Ler antes:** `app/src/hooks/useConversation.ts` (`toThread`, `seal`,
`sendEvent`, a fila `frameQueue`), `app/src/components/MessageBubble.tsx`
(`useMediaSource`), `app/src/screens/ConversationsScreen.tsx` (`openPreviews`),
`app/src/screens/ThreadScreen.tsx` (faixa e safety number),
`app/src/components/SafetyNumber.tsx`.

**Tarefas:** dois perfis do navegador (ou um normal + um anônimo), `alice` e
`bob`, conversando.

1. **Texto.** Mandar dos dois lados. Cadeado fechado 🔒 no cabeçalho, sem faixa
   de aviso, texto legível nas duas telas.
2. **Não confiar na tela.** Confirmar no servidor que o que foi guardado é
   ciphertext — a `smoke:phase15` já faz isso por HTTP, mas aqui é o texto que
   *este cliente* produziu:
   ```bash
   npx wrangler d1 execute goodchat --local --json \
     --command "SELECT id, user_a, user_b FROM conversations;"
   ```
   e ler o histórico pelo socket, ou conferir `body` no frame `history` no
   DevTools → Network → WS. Nenhum trecho do que foi digitado pode aparecer.
3. **Emoji e sticker.** Sticker precisa renderizar a arte, não o placeholder
   `[sticker]` — é o caminho onde o id sai do ciphertext e passa pelo
   `STICKER_ID_RE` no destinatário.
4. **Imagem.** Bolha renderiza; e `GET /api/media/<key>` com o cookie de sessão,
   fora do app, tem que devolver bytes ilegíveis.
5. **Vídeo.** Confirmar que toca — e que a espera é o download inteiro, que é a
   regressão conhecida e documentada (AES-GCM autentica o objeto todo).
6. **Previews da lista.** Voltar para `#/`: o tile mostra o texto da última
   mensagem, não `[mensagem cifrada]` nem base64.
7. **Recarregar dentro da thread.** O cache local não serializa `CryptoKey`, então
   a mídia deve mostrar esqueleto e resolver quando o `history` chegar — nunca
   "[mídia indisponível]".
8. **Segundo aparelho.** Entrar como `alice` num terceiro perfil: mensagens
   novas abrem nos dois; as antigas mostram
   `[mensagem de antes deste dispositivo]`. Isso é o desenho funcionando, não
   falha.
9. **Safety number.** Abrir o 🔒 nos dois lados e comparar: têm que ser
   idênticos, 12 grupos de 5 dígitos.
10. **Aviso de troca de chave.** Apagar o IndexedDB de um dos lados, recarregar
    (gera identidade nova), e reabrir a thread do outro lado: a faixa "os
    aparelhos de @fulano mudaram" tem que aparecer.
11. **Push com preview.** Ativar notificações, pôr `push_preview` em "mostrar
    trecho", mandar mensagem com a aba fechada: a notificação mostra o texto — e
    o log do worker (`/tmp/wrangler-dev.log`) não contém nenhum trecho dele.
12. **Fechar a transição.** `E2EE_REQUIRED=true` no `.dev.vars`, reiniciar o
    worker, mandar de um navegador sem chave (anônimo): tem que ser recusado com
    `encryption_required` visível, não engolido.

**Critérios de aceite:** todos os doze; nenhum erro no console do navegador; e o
passo 2 e o 4 — que são os únicos que provam a propriedade, o resto prova a
usabilidade.

**Não fazer:** não automatizar com Playwright dentro desta fase. Vale a pena, e é
o que tornaria isto repetível em CI, mas hoje o projeto não tem nenhuma
infraestrutura de teste de navegador e adicionar uma é uma decisão de escopo
própria (dependência nova, tempo de CI, um segundo lugar onde a criptografia é
descrita). Anotar no handoff o que doeu manualmente, que é a evidência para
decidir depois.

**Handoff:** _(preencher ao concluir: navegadores e versões usados, o que
apareceu no passo 2 e no 4, e qualquer passo que precisou de retentativa)_

---

## Depois destas duas

Nada mais fica sem execução no caminho criptográfico. O que continua em aberto é
de produto, não de verificação, e está registrado em `docs/architecture.md`:

- sem forward secrecy (ECDH estático; a janela de 7 dias é o que limita uma
  chave vazada);
- vídeo baixa inteiro antes de tocar — AES-CTR + MAC do objeto inteiro via Media
  Source Extensions seria a saída;
- avatares, nomes e presença seguem em texto claro, porque são renderizados para
  contas com quem você nunca falou.
