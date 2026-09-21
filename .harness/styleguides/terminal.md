# Skin `terminal` — style guide

**Escopo:** só a skin `terminal`. Base compartilhada (paletas, temas, fonte,
motion, contrato de skin, receita CSS) está em [../styleguide.md](../styleguide.md).
Esta skin, quando ativa, vale para o **app inteiro** — login, lista, thread,
composer, console de admin, modais.

- `data-skin='terminal'` · label na tela de aparência: **terminal**
- Arquivos: bloco de tokens em `app/src/styles/skins.css` + a tomada de conta em
  `app/src/styles/skin-terminal.css` (importado logo depois; a divisão é só por
  tamanho, a cascata é a mesma).

---

## 1. Identidade

**Um CRT com um log rodando nele.** Não é a skin retro mais fina: é outra
máquina. A página é vidro escuro atrás de um bezel, as superfícies não sobem —
elas são separadas por **linhas de fósforo**. Títulos viram prompt de shell,
a lista de conversas vira listagem de diretório, a thread vira log de IRC, o
composer vira linha de comando, botões viram `[ comandos ]`.

A frase que resolve dúvida de implementação: *o retro preenche, o terminal
risca.* Aqui quase nada tem fill; o que existe é hairline em accent, wash de
accent a 3–6% e glow. Fill sólido em accent fica reservado para **um** estado:
a inversão de seleção (linha em hover, botão em hover) — o idioma de qualquer
TUI.

**O que a skin retira, de propósito:** o levante no hover
(`hover:-translate-y-1` é neutralizado com `transform: none`) — nada flutua numa
tela de fósforo; a sombra dura; o fill `base-200`; o display itálico gordo.

Origem: adaptado do site-portfólio do autor.

---

## 2. Cores (uso)

As cores em si são compartilhadas (`../styleguide.md` §2.1–2.2, dez paletas —
todas funcionam aqui; as de accent forte, tipo neon matrix e cyber teal, é que
mostram melhor o glow). O que é da skin é a **diluição**: quase tudo é accent
misturado com transparente, em degraus fixos.

| Degrau | Onde |
|---|---|
| accent 3–6% | corpo de painel, wash da barra de thread, vidro do diálogo (4%), fundo de botão (5%) |
| accent 8–10% | avatar, skeleton, linha inferior da barra de janela (10%) |
| accent 14–16% | hairline de linha de lista e de `admin-row` (14%), bezel do CRT (16%) |
| accent 22–30% | moldura de painel/input/botão (30%), moldura de mídia (25%), topo do composer (25%), track do medidor (22%) |
| accent 100% | texto de destaque, caret, prefixos, e o fill da inversão em hover |

Vignette do CRT: `--crt-edge` (do tema) — sempre preto, nunca derivado de
`base-300`, senão as paletas escuras acenderiam os cantos em vez de escurecê-los.

Cores de estado (`error`, `warning`, `success`) continuam sendo as do tema:
chips viram `[texto]` colorido em vez de bloco preenchido.

---

## 3. Tipografia (tratamento)

Família compartilhada (JetBrains Mono). O tratamento é oposto ao da retro —
**nada de display gordo e itálico**; tudo é micro-tipografia larga:

| Uso | Tratamento |
|---|---|
| Título de tela (`screen-title`) | `1.375rem` (≥40rem: `1.75rem`), peso **700**, `font-style: normal`, `letter-spacing: 0.3em`, sem sublinhado, cor accent, `text-shadow: 0 0 12px`, seguido de um caret em bloco piscando |
| Kicker (`screen-kicker`) | **minúsculas** (um prompt não grita) e o `>` do markup vira o prompt `goodchat@tty1:~$` em `0.75rem`, `opacity: .55` |
| Linha de status (`screen-meta`) | accent, `opacity: .45` |
| Label de seção (`section-label`) | `[ LABEL ]` — o `>` some, colchetes em `opacity: .45`, `letter-spacing: .2em`, hairline embaixo (accent 15%, `padding-bottom: .375rem`) |
| Linha de saída (`prompt-line`) | o `>` vira `$` |
| Log da thread | `0.8125rem`, `line-height: 1.55` |
| Nome/valor em destaque | accent + `text-shadow: 0 0 10px currentColor` |

O glow chega por `[data-skin='terminal'] .text-accent { text-shadow: 0 0 10px
currentColor }` — via `currentColor` e não via token, para sobreviver ao hover
que inverte o texto.

---

## 4. Motifs

1. **Bezel + glass** (`.crt`, montado uma vez pelo `App.tsx`, invisível nas
   outras skins) — `position: fixed; inset: 0.25rem`, borda 1px accent 16%,
   `z-index: 90`, `pointer-events: none`.
2. **Vignette + dot grid** (`.crt::before`, esticado a `-0.25rem`) — elipse
   escurecendo a partir de 45% com `--crt-edge`, sobre um grid de pontos de 1px
   a cada 26px em accent 9%.
3. **Roll** (`.crt::after`) — banda de 30% de altura em accent 5% descendo em
   `crt-roll 7s linear infinite`. Movimento ambiente; **desligado por completo**
   sob `prefers-reduced-motion` (congelada, viraria uma faixa parada).
4. **Scanline forte** — `terminal-scanline` reescrita: banda de 4px,
   `opacity: .22`. Lê como tela, não como textura.
5. **Glow de fósforo** — `0 0 10px currentColor` em `.text-accent`, `12px` no
   título de tela.
6. **Caret em bloco** — `terminal-cursor` vira bloco de `0.6em × 1.05em` em
   accent, com o caractere transparente por baixo; `blink 1s step-end`.
7. **WindowDots** — um accent que apaga: `accent`, `accent 40%`, `accent 20%`
   (contra o accent-e-dois-cinzas da retro).
8. **Barra de janela** (`window-bar`) — wash accent 5% sob hairline
   `var(--frame-border)` accent 10%, `padding: .5rem 1rem`; título em accent
   `opacity .5`, peso 400, `letter-spacing: .05em`, **minúsculo** e prefixado de
   `~/` (`~/contas.cfg`).
9. **Colchetes como chrome** — `[ config ]` nos botões de barra, `[3]` no
   contador de não lidas, `[ativo]` nas tags. Sempre por pseudo-elemento: o
   texto no markup continua uma palavra limpa para leitor de tela e para a
   outra skin.
10. **Cursor de gutter** — `>` em `::before` de cada linha da lista,
    `opacity .3`, acendendo em hover.
11. **Sem levante** — `transform: none` no hover das três utilities de moldura.
    A inversão de cor é o feedback.
12. **Foco tracejado** — `outline-style: dashed`, `outline-offset: 1px`
    (a espessura e a cor continuam vindo da regra global). `caret-color` de
    `input`/`textarea` em accent.
13. **`prefers-reduced-motion`** — herda o congelamento global e mata o roll.

**Não existem nesta skin** (não inventar): sombra dura deslocada, fill
`base-200`, título itálico, cantos arredondados (radius 0 vem do tema),
levante no hover.

### Motion

- Entrada: a mesma `animate-enter` compartilhada (fade + 8px, 200ms, ease-out).
- Ambiente: roll do CRT (7s), caret piscando (1s), scanline estática.
- Interação: só troca de cor — inversão accent/accent-content. Nenhum transform.

---

## 5. Geometria e tokens

| Token | Valor |
|---|---|
| `--frame-border` | `1px` |
| `--frame-shadow` | anel 1px accent 30% + `0 0 18px -4px` accent 45% |
| `--frame-shadow-sm` | anel 1px accent 22% + `0 0 10px -4px` accent 35% |
| `retro-border` (cor) | accent 30% — a moldura é fósforo, não `base-300` |

O anel hairline mantém a moldura legível em paleta cujo accent quase não brilha;
o halo desfocado carrega as que brilham. Os dois juntos são a "sombra" da skin.

Densidade: a skin **aperta** tudo. Painel `padding: 1rem`; linha de lista
`.625rem .5rem`; barra de thread `.5rem .75rem`; log com `gap: .125rem` e
mensagem com `padding: .0625rem 0`; botão 2.5rem de altura contra os 3.25/3.75rem
da retro.

---

## 6. Componentes

**Botão** (`btn-goodchat`, `btn-goodchat-outline`) — fantasma: fill accent 5%,
texto accent, borda accent 30% via `--btn-border`, `--btn-p: 1rem`,
`--size: 2.5rem`, `--fontsize: .75rem`, peso 700 — sem crescer no breakpoint.
Hover inunda de accent (`background: accent`, `color: accent-content`), porque
5% é fraco demais para ler um hover.

**Botão de barra** (`icon-btn`) — fill accent 5%, texto accent,
`letter-spacing: .1em`, envolto em `[ ]`; hover inunda de accent.
**Ferramentas do composer** (`tool-btn`) — mesmo fantasma, **sem** colchetes:
são glifos (`+`, `:)`, `▦`), não comandos.

**Painel** (`panel`) — sem superfície elevada: borda accent 30% de
`var(--frame-border)` sobre `base-100` com 3% de accent misturado.
`panel-body` com `padding: 1rem`. **Diálogo** (`dialog-box`): mesmo vidro, 4%.

**Input** (`input`) — sem campo elevado: fundo accent 4%, borda accent 30%.
**Skeleton** — fósforo apagado (accent 10%), não bloco cinza.

**Lista de conversas** (`tile`) — vira listagem de diretório: sem moldura, sem
fill, sem sombra; só um hairline embaixo (accent 14%) e o `>` no gutter.
Hover **mantém** a inundação de accent do markup (é a barra de seleção de TUI).
`tile-name` em accent com glow; `tile-unread` sem chip, escrito `[3]`.

**Avatar** (`avatar-sq`) — quadrado de fósforo: fundo accent 8%, inicial em
accent. Sob hover da linha, inverte para accent-content 12%.

**Presença** (`presence-dot`) — perde o anel (não há superfície elevada para
recortar) e ganha halo `0 0 8px` de `success` **só quando online**
(`[data-online='true']`) — um ponto apagado brilhando diria o contrário.

**Thread** (`msg`) — a peça central. O balão é desmontado (sem moldura, fill,
sombra, 80% de largura ou `self-end`) e cada mensagem vira uma linha de log:

```
[14:22] <alice> oi
[14:23] <bob> e aí ✓✓
```

O prefixo é `::before` montado de `attr(data-time)` e `attr(data-sender)` —
atributos que o componente sempre escreve e a retro ignora. `msg-body` vira
`display: inline` (como bloco, quebraria linha e dobraria a altura do log).
`msg-meta` some: a hora está no prefixo e o estado vira glifo no fim da linha
(`…` enviando, `✓` enviada, `✓✓` entregue, `✓✓` opaco 1 lida). Mensagem própria
se distingue por **cor** (accent), não por lado. Mídia direta ganha moldura de
1px accent 25% e `max-height: 14rem`; sticker mantém a placa e alinha à esquerda.

**Barra da thread** (`thread-bar`) — wash accent 6%, sem sombra, nome do peer
(`thread-name`) em accent com glow e `letter-spacing: .08em`.

**Composer** (`composer`) — sem campo flutuante: hairline no topo (accent 25%),
fundo transparente, prefixo `msg>` em accent com glow antes do caret;
placeholder em accent `opacity .35`.

**Console de admin** — vira readout: `stat-tile` transparente e sem sombra,
`stat-label` prefixado de `# `, `stat-value` em accent com glow; `admin-row`
com o mesmo hairline da lista; `admin-handle` em accent com glow; `tag` vira
`[palavra]` colorida pelo estado (`tag-accent|error|warning|muted`);
`usage-track` vira caixa de 1px accent 22% e `usage-fill` vira blocos
(`▮▮▮▮░░`) por gradiente repetido de 4px cheios / 2px vazios — a proporção
continua exata.

**Swatch de aparência** (`skin-swatch`) — a prévia da skin desenha as próprias
scanlines, e a prévia da retro reivindica a face limpa de volta
(`[data-skin='retro'] .skin-swatch`), senão as duas prévias mentiriam.

---

## 7. Origem e decisões

Adaptada do site-portfólio do autor; as decisões que continuam valendo estão nas seções acima.

Histórico: a `terminal` nasceu **sem style guide**, como um bloco de três tokens
em `skins.css`. Ganhou este arquivo quando virou uma tomada de conta do app
inteiro — o critério de `../styleguide.md` §5.2 na prática.
