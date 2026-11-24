"""Startup banner for interactive DevHarbour setup: a colored puffin and wordmark.

The puffin is pixel art drawn with Unicode half blocks. Each terminal cell shows
two vertical pixels: the upper pixel as foreground of an upper half block and the
lower pixel as background. Colors follow the Nord palette used by DevHarbour.
Color is disabled for NO_COLOR, TERM=dumb and non-terminal output.
"""
import os
import shutil

# One character per pixel. '.' is transparent.
PUFFIN = [
    '...........KKKKKK...........',
    '.........KKKKKKKKKK.........',
    '........KKKKKKKKKKKK........',
    '.......KKWWWWWWWWWWKK.......',
    '.......KWWWWWWWWWWWWWYB.....',
    '......KWWWWWWWWEEWWWWYBRR...',
    '......KWWWWGGGGEEWWWWYBRRRO.',
    '......KWWWWWWWWWWWWWWYBRROOO',
    '......KWWWWWWWWWWWWWWYBROOO.',
    '......KKWWWWWWWWWWWWWYBOO...',
    '.......KKWWWWWWWWWWWWYO.....',
    '.......KKKKWWWWWWKKK........',
    '......KKKKKKKKKKKKKKK.......',
    '.....KKKKKKKKKKWWWWWK.......',
    '....KKKKKKKKKKWWWWWWWK......',
    '...KKKKKKKKKKWWWWWWWWWK.....',
    '...KKKKKKKKKWWWWWWWWWWK.....',
    '..KKKKKKKKKKWWWWWWWWWWK.....',
    '..KKKKKKKKKKWWWWWWWWWWK.....',
    '..KKKKKKKKKKKWWWWWWWWK......',
    '...KKKKKKKKKKWWWWWWWWK......',
    '....KKKKKKKKKKWWWWWWK.......',
    '.....KKKKKKKKKKKKKKK........',
    '........OO......OO..........',
    '.......OOOO....OOOO.........',
    '............................',
]

# Nord-inspired colors. Plumage uses a lighter slate so it remains visible on
# black terminal backgrounds.
COLORS = {
    'K': (76, 86, 106),     # plumage, nord3
    'W': (236, 239, 244),   # face and belly, nord6
    'G': (143, 154, 175),   # facial line
    'E': (46, 52, 64),      # eye, nord0
    'Y': (235, 203, 139),   # beak base, nord13
    'B': (129, 161, 193),   # beak plate, nord9
    'R': (191, 97, 106),    # beak stripe, nord11
    'O': (208, 135, 112),   # beak tip and feet, nord12
}

# ANSI Shadow lettering for DEVHARBOUR, the style used by devbootstrap.
WORDMARK = [
    '██████╗ ███████╗██╗   ██╗██╗  ██╗ █████╗ ██████╗ ██████╗  ██████╗ ██╗   ██╗██████╗ ',
    '██╔══██╗██╔════╝██║   ██║██║  ██║██╔══██╗██╔══██╗██╔══██╗██╔═══██╗██║   ██║██╔══██╗',
    '██║  ██║█████╗  ██║   ██║███████║███████║██████╔╝██████╔╝██║   ██║██║   ██║██████╔╝',
    '██║  ██║██╔══╝  ╚██╗ ██╔╝██╔══██║██╔══██║██╔══██╗██╔══██╗██║   ██║██║   ██║██╔══██╗',
    '██████╔╝███████╗ ╚████╔╝ ██║  ██║██║  ██║██║  ██║██████╔╝╚██████╔╝╚██████╔╝██║  ██║',
    '╚═════╝ ╚══════╝  ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝',
]
# Nord frost gradient, top to bottom.
WORDMARK_COLORS = [(143, 188, 187), (136, 192, 208), (136, 192, 208), (129, 161, 193), (129, 161, 193), (94, 129, 172)]
TAGLINE = 'Your harbour for devcontainers'
RESET = '\033[0m'


def color_mode(stream, environ=None):
    """Return 'truecolor', '256' or None for the given output stream."""
    environ = os.environ if environ is None else environ
    if 'NO_COLOR' in environ or environ.get('TERM', '') == 'dumb' or not hasattr(stream, 'isatty') or not stream.isatty():
        return None
    return 'truecolor' if environ.get('COLORTERM', '').lower() in {'truecolor', '24bit'} else '256'


def ansi(rgb, mode, background=False):
    """Return a foreground/background escape for one RGB color."""
    red, green, blue = rgb
    if mode == 'truecolor':
        return '\033[' + ('48' if background else '38') + ';2;%d;%d;%dm' % (red, green, blue)
    # Map to the 6x6x6 color cube of 256-color terminals.
    index = 16 + 36 * round(red / 255 * 5) + 6 * round(green / 255 * 5) + round(blue / 255 * 5)
    return '\033[' + ('48' if background else '38') + ';5;' + str(index) + 'm'


def puffin_lines(mode):
    """Combine pixel row pairs into half-block terminal lines."""
    lines = []
    for row in range(0, len(PUFFIN), 2):
        upper, lower = PUFFIN[row], PUFFIN[row + 1]
        line = ''
        for top, bottom in zip(upper, lower):
            if top == '.' and bottom == '.':
                line += ' '
            elif top == '.':
                line += ansi(COLORS[bottom], mode) + '▄' + RESET
            elif bottom == '.':
                line += ansi(COLORS[top], mode) + '▀' + RESET
            else:
                line += ansi(COLORS[top], mode) + ansi(COLORS[bottom], mode, True) + '▀' + RESET
        lines.append(line)
    return lines


def render(mode, width, version=''):
    """Build the banner for a color mode and terminal width."""
    subtitle = TAGLINE + ('   ' + version if version else '')
    if mode is None:
        if width >= len(WORDMARK[0]):
            return '\n'.join(WORDMARK + [subtitle, ''])
        return 'DevHarbour\n' + subtitle + '\n'
    bold = '\033[1m'
    muted = ansi((216, 222, 233), mode)
    words = [ansi(color, mode) + bold + line + RESET for line, color in zip(WORDMARK, WORDMARK_COLORS)]
    text = [muted + subtitle + RESET]
    bird = puffin_lines(mode)
    bird_width = len(PUFFIN[0])
    if width >= bird_width + 3 + len(WORDMARK[0]):
        # Wordmark beside the puffin, vertically centered on the head and body.
        block = [''] * 3 + words + [''] + text
        block += [''] * (len(bird) - len(block))
        return '\n'.join(b + '   ' + w for b, w in zip(bird, block)) + '\n'
    if width >= len(WORDMARK[0]):
        return '\n'.join(bird + [''] + words + text) + '\n'
    title = ansi(WORDMARK_COLORS[1], mode) + bold + 'DevHarbour' + RESET
    if width >= bird_width:
        return '\n'.join(bird + [title] + text) + '\n'
    return title + '\n' + text[0] + '\n'


def show(stream, version=''):
    """Print the banner to an interactive stream; never fail setup for decoration."""
    try:
        width = shutil.get_terminal_size((80, 24)).columns
        stream.write(render(color_mode(stream), width, version) + '\n')
        stream.flush()
    except (OSError, ValueError):
        pass
