# Skin `retro` — style guide

**Escopo:** só a skin `retro`. Base compartilhada (paletas, temas, fonte, motion,
contrato de skin, receita CSS) está em [../styleguide.md](../styleguide.md).
Esta skin, quando ativa, vale para o **app inteiro** — login, lista, thread,
composer, console de admin, modais.

- `data-skin='retro'` · label na tela de aparência: **neobrutal**
- **É a skin default** (`DEFAULT_SKIN` em `app/src/lib/skins.ts`): conta que
  nunca escolheu, e documento antes do boot do tema, já estão nela.
- Arquivo: bloco `:root, [data-skin='retro']` em `app/src/styles/skins.css`.
  A skin é pequena em CSS porque é a linha de base: as utilities de
  `index.css` já falam retro por padrão.

---

## 1. Identidade

**Neobrutalismo.** Cantos 100% retos, molduras grossas, sombra dura deslocada
sem blur, tipografia display gorda e itálica, hover que **levanta** o elemento
como se fosse um cartão físico sendo pego.

A frase que resolve dúvida de implementação: *o retro preenche, o terminal
risca.* Aqui a cor vive no **fill** (avatar accent sólido, balão enviado accent,
tile que inunda de accent no hover) e a borda é uma linha neutra de `base-300`.

Origem: adaptado do site-portfólio do autor.

---

## 2. Cores (uso)

As cores em si são compartilhadas (`../styleguide.md` §2.1–2.2, dez paletas).
O que é da skin é **onde** cada token vai:

| Papel | Token |
|---|---|
| Fundo de página | `base-100` |
| Superfície elevada (painel, tile, balão recebido, input) | `base-200` |
| Toda moldura | `base-300` — a moldura é neutra, nunca accent |
| Sombra dura | `--shadow` (declarado por tema) |
| Ênfase / estado ativo / balão enviado / avatar | `accent` + `accent-content` |
| Micro-texto decorativo | `base-content` com `opacity-40`–`70` |

**Padrão notável dos temas escuros:** a cor da borda (`base-300`) é a cor
*clara* do texto. Borda forte e visível nos dois modos — nunca cinza sutil.

---

## 3. Tipografia (tratamento)

Família compartilhada (JetBrains Mono). O tratamento é da skin:

| Uso | Tratamento |
|---|---|
| Título de tela (`screen-title`) | `text-3xl`→`4xl` (login: `5xl`→`6xl`), `font-black`, `uppercase`, **`italic`**, `tracking-tighter`; no login com `underline decoration-accent decoration-4 underline-offset-4` |
| Kicker (`screen-kicker`) | `font-mono text-xs font-bold uppercase tracking-widest text-accent`, precedido do `>` literal (`.sigil`) |
| Label de seção (`section-label`) | igual ao kicker, ou `text-[10px] tracking-[0.2em]` na variante compacta; também com `>` |
| Corpo | `text-sm`/`text-base`, `leading-relaxed` |
| Micro-texto (hora, status, meta) | `font-mono text-[10px] uppercase tracking-[0.2em]` + `opacity-40`–`60` |

Padrões-chave: **caixa alta em tudo que não é corpo**, `tracking-tighter` nos
títulos grandes e `tracking-widest`/`[0.2em]` nos micro-labels, itálico como
recurso de display, `font-black`/`font-bold` dominantes.

> `font-black` é 900 e a face mais pesada carregada é 800 — o browser resolve
> para 800. Comportamento herdado do site-portfólio e **aprovado**; não "corrigir".

---

## 4. Motifs

Numerados: o código referencia estes itens por número (`styleguide retro §4.3`).

1. **Sombra dura deslocada** — a assinatura nº 1. `--frame-shadow: 6px 6px 0 0
   var(--shadow)`, `--frame-shadow-sm: 3px 3px 0 0 var(--shadow)`. Sem blur, sem
   spread. Consumidas por `retro-shadow` / `retro-shadow-sm`.
2. **Moldura grossa reta** — `--frame-border: 2px`, cor `base-300`, via
   `retro-border`.
3. **Zero border-radius** — `--radius-selector/field/box: 0rem` em todos os
   temas. Todo canto do app é reto, inclusive o ponto de presença (quadrado, não
   círculo) e o avatar. Exceção deliberada: nenhuma.
4. **Scanline discreta** — `terminal-scanline` na força base: gradiente
   repetido de 1px a cada 4px, `opacity: 0.3`, `position: fixed`,
   `pointer-events: none`. É textura, não tela — o CRT é da outra skin.
5. **Caret piscando** — `terminal-cursor` = `_` com `blink 1s step-end
   infinite`. Usado no estado "enviando" e em indicação de digitação, no lugar de
   três bolinhas saltitantes.
6. **Micro-texto de máquina** — prefixo `>` nos kickers e labels, previews em
   colchetes (`[imagem]`, `[sticker]`), estados escritos em caixa alta.
7. **WindowDots** — três círculos de janela de SO: `bg-accent`, `bg-base-300`,
   `bg-base-300` (componente `WindowDots.tsx`, hook `window-dots`).
8. **Barra de título de painel** (`window-bar`) — linha inferior de 2px em
   `base-300` sobre `base-100`, com o nome do "arquivo" em micro-texto bold
   `opacity-40` **em caixa alta** (`CONTAS.CFG`) e os WindowDots à direita.
9. **Levantar no hover** — `hover:-translate-y-1` + sombra `sm`→padrão, e
   `active:translate-y-0` (pressiona de volta). `transition-all duration-300`.
   É o gesto mais retro do app.
10. **Seleção temática** — `::selection` em accent/accent-content.
11. **Botão como CTA grande** — 3.25rem (md: 3.75rem) de altura, peso 900,
    caixa alta (ver §6).
12. **Foco visível** — `outline: 2px solid var(--color-accent)`, `outline-offset:
    2px`, linha sólida.
13. **`prefers-reduced-motion`** — animações congeladas, scanline escondida.

**Não existem nesta skin** (não inventar): glow de fósforo, vignette/curvatura
de CRT, dot grid, dithering, glitch, fonte pixel, borda pixel-stepped, prompt de
shell. Tudo isso é da skin `terminal`.

### Motion

- Entrada: `animate-enter` — fade + `translateY(8px)` → 0 em 200ms, ease-out,
  **zero overshoot**. Sem spring, sem bounce (regra de time).
- Interação: `hover:-translate-y-1` + crescimento de sombra, `duration-300`;
  `active` volta ao lugar.
- Ambiente: caret piscando (1s) e scanline estática. Nada mais se mexe sozinho.

---

## 5. Espaçamento e geometria

| Token | Valor |
|---|---|
| `--radius-selector` / `--radius-field` / `--radius-box` | `0rem` |
| `--border` (controles daisyUI) | `2px` |
| `--frame-border` | `2px` |
| `--frame-shadow` / `--frame-shadow-sm` | `6px 6px 0 0` / `3px 3px 0 0` |
| `--depth` / `--noise` | `0` |

Convenções (escala Tailwind padrão, sem customização): painel `card-body` com
`gap-4`; tile `p-4` e `gap-3`; balão `p-3`; barra de título `px-4 py-3`; botão
de ícone `px-3 py-2`; largura máxima de balão `80%` (`sm:70%`).

---

## 6. Componentes

**Botão** — `btn-goodchat` (fill accent) e `btn-goodchat-outline`
(transparente, texto `base-content`): borda `base-300`, `--btn-p: 2rem`,
altura `3.25rem`→`3.75rem` (md), fonte `0.875rem`→`1rem`, peso 900, caixa alta,
`letter-spacing: 0.05em`. Estendem o `btn` do daisyUI pelos tokens dele.

**Painel** (`panel`) — `card card-border border-base-300 bg-base-200` +
`retro-shadow`, barra de título (§4.8) e `panel-body` com `card-body`.

**Botão de ícone / ação de barra** (`icon-btn`) — `retro-border bg-base-200`,
`text-[10px] font-black uppercase tracking-widest`, hover accent + levanta,
`disabled:opacity-40`.

**Tile de conversa** (`tile`) — o padrão de item interativo da skin:
`retro-border bg-base-200 p-4 retro-shadow-sm` + `hover:bg-accent
hover:text-accent-content hover:-translate-y-1 hover:retro-shadow` +
`active:translate-y-0`. Nome em bold, preview em `opacity-70`, hora e
contador de não lidas em micro-texto.

**Avatar** (`avatar-sq`) — quadrado com `retro-border`, fill `accent` e a
inicial em `accent-content` `font-black uppercase` quando não há foto.

**Presença** (`presence-dot`) — quadrado de 12px com anel de 2px em `base-200`
recortando a superfície; verde quando online, apagado quando não.

**Balão** (`msg`) — recebido: `bg-base-200` + `retro-border`; enviado:
`bg-accent text-accent-content` + `retro-border`; ambos `retro-shadow-sm`,
`p-3`, radius 0, alinhados a lados opostos da coluna (`max-w-[80%]`).
Meta (`msg-meta`) embaixo, micro-texto com hora e `✓`/`✓✓`.

**Composer** (`composer`) — campo `retro-border` sobre `base-200`, radius 0,
botões de ferramenta (`tool-btn`) no mesmo padrão de tile compacto.

**Console de admin** — `stat-tile` como cards elevados (`base-200` + moldura),
`admin-row` como linhas com fill, `tag` como chip preenchido (accent / error /
warning / muted), `usage-track`/`usage-fill` como barra sólida.

---

## 7. Origem

Adaptada do site-portfólio do autor; as decisões que continuam valendo estão nas seções acima.
