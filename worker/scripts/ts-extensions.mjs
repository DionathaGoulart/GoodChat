// Registers the resolver hook next door. Used as `node --import ./scripts/ts-extensions.mjs`.
import { register } from 'node:module'

register(new URL('./ts-extension-hooks.mjs', import.meta.url))
