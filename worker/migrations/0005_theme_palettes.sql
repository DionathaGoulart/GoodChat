-- Migration 0005: the theme preference splits into a mode and two palettes.
--
-- Until now `users.theme` held a daisyUI theme name and there were exactly two
-- of them, so "which theme" and "light or dark" were the same question. The
-- settings screen now offers ten palettes — four light, six dark — and the two
-- questions come apart: the mode says whether to use a light or a dark palette
-- (or to follow the OS), and each mode remembers which palette it uses. Ask a
-- person to pick one theme instead and the light/dark toggle loses its meaning.
--
-- `theme` is renamed rather than kept, because its values change meaning:
-- 'goodchat-light' / 'goodchat-dark' become 'light' / 'dark'. NULL still means
-- "follow the operating system".
--
-- theme_light / theme_dark stay NULL for accounts that never chose. The client
-- resolves NULL to the catalog default (goodchat-crimson / goodchat-rose) —
-- the same colors the app shipped with — so nobody's screen changes here, and
-- a palette that is later retired degrades to the default instead of leaving
-- an account pinned to a theme no stylesheet answers to.

ALTER TABLE users RENAME COLUMN theme TO theme_mode;

UPDATE users
SET theme_mode = CASE theme_mode
  WHEN 'goodchat-light' THEN 'light'
  WHEN 'goodchat-dark' THEN 'dark'
  ELSE NULL
END;

ALTER TABLE users ADD COLUMN theme_light TEXT;
ALTER TABLE users ADD COLUMN theme_dark TEXT;
