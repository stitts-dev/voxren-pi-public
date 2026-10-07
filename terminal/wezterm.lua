-- The terminal `coach` opens itself in on Windows (bin/coach.mjs): one look and one picture path on every machine.
-- Loaded with --config-file, so the player's own ~/.wezterm.lua never applies here.
local wezterm = require 'wezterm'
-- WezTerm's bundled copy of iTerm2's own dark theme.
local scheme = 'iTerm2 Smoooooth'
local ground = wezterm.color.get_builtin_schemes()[scheme].background

return {
  -- Bundled with WezTerm, so every machine has it.
  font = wezterm.font 'JetBrains Mono',
  -- Sized to be read from a chair, not to fit the most rows: an inline icon is one row tall, so the icons grow with it.
  font_size = 15.0,
  initial_cols = 120,
  initial_rows = 36,
  color_scheme = scheme,
  -- The cursor is drawn in the background colour: the coach keeps it shown so ConPTY places everything right on
  -- Windows (keepCursorShown in src/terminal-images.ts), and Pi draws its own cursor in the editor.
  colors = { cursor_bg = ground, cursor_border = ground },
  -- Frosted glass: the desktop shows through the dark ground, blurred (Acrylic on Windows, blur on macOS).
  window_background_opacity = 0.85,
  win32_system_backdrop = 'Acrylic',
  win32_acrylic_accent_color = ground,
  macos_window_background_blur = 30,
  -- Smooth redraws and scrolling on high-refresh screens.
  max_fps = 120,
  animation_fps = 60,
  hide_tab_bar_if_only_one_tab = true,
  window_padding = { left = 8, right = 8, top = 6, bottom = 6 },
  -- Pictures go out the iTerm2 way (PI_IMAGE_PROTOCOL=iterm2 from bin/coach.mjs): ConPTY drops Kitty's APC sequences on Windows.
  enable_kitty_graphics = false,
  window_close_confirmation = 'NeverPrompt',
  exit_behavior = 'Close',
  check_for_updates = false,
  audible_bell = 'Disabled',
  -- Ctrl+V pastes, as it does everywhere else on Windows: WezTerm's own paste keys (Ctrl+Shift+V, Shift+Insert, Cmd+V on
  -- macOS) still work, and nothing in the coach reads a bare Ctrl+V.
  keys = { { key = 'v', mods = 'CTRL', action = wezterm.action.PasteFrom 'Clipboard' } },
}
