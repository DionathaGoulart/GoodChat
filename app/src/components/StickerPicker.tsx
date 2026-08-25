// Sticker picker popover content: grid of the curated pack (lib/stickers).
// Clicking a sticker sends it immediately — stickers are a whole message,
// not composer text.

import { stickerAssetUrl, useStickerPack } from '../lib/stickers'
import { MEDIA_CROSS_ORIGIN } from '../lib/media'

export function StickerPicker({ onPick }: { onPick: (stickerId: string) => void }) {
  const { pack, error } = useStickerPack()

  if (error) {
    return (
      <p className="p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
        falha ao carregar stickers
      </p>
    )
  }
  if (!pack) {
    return (
      <div className="grid grid-cols-3 gap-2 p-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton aspect-square w-full" />
        ))}
      </div>
    )
  }
  return (
    <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto p-2">
      {pack.stickers.map((sticker) => (
        <button
          key={sticker.id}
          type="button"
          title={sticker.label}
          aria-label={`enviar sticker ${sticker.label}`}
          onClick={() => onPick(sticker.id)}
          className="cursor-pointer transition-all duration-300 hover:-translate-y-1 hover:retro-shadow-sm active:translate-y-0"
        >
          <img
            src={stickerAssetUrl(sticker)}
            crossOrigin={MEDIA_CROSS_ORIGIN}
            alt=""
            className="aspect-square w-full"
          />
        </button>
      ))}
    </div>
  )
}
