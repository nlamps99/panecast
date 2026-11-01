package com.genie.cmuxremote.term

import androidx.compose.ui.graphics.Color

/** Character-cell attributes produced by SGR sequences. */
data class AnsiAttr(
    val fg: Int = -1,          // resolved ARGB, -1 = default
    val bg: Int = -1,
    val bold: Boolean = false,
    val dim: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val inverse: Boolean = false,
    val strike: Boolean = false,
) {
    companion object {
        val DEFAULT = AnsiAttr()
    }
}

/** One printable character + its attributes. */
data class AnsiCell(val char: Char, val attr: AnsiAttr)

/** A run of cells sharing attributes — what the renderer actually consumes. */
data class AnsiSpan(val text: String, val attr: AnsiAttr)

/**
 * ANSI/VT100 SGR parser. Port of ios/CmuxRemote/Terminal/ANSIParser.swift,
 * extended with dim/italic/inverse/strikethrough and the full xterm 256-color
 * cube. Non-SGR escape sequences are consumed and ignored.
 */
object AnsiParser {

    fun parseCells(line: String, base: AnsiAttr = AnsiAttr.DEFAULT): List<AnsiCell> {
        val out = ArrayList<AnsiCell>(line.length)
        var attr = base
        var i = 0
        val n = line.length
        while (i < n) {
            val c = line[i]
            if (c == '\u001B' && i + 1 < n) {
                val next = line[i + 1]
                if (next == '[') {
                    // CSI: consume until final byte 0x40–0x7E
                    var j = i + 2
                    val args = StringBuilder()
                    while (j < n) {
                        val f = line[j]
                        if (f.code in 0x40..0x7E) {
                            if (f == 'm') attr = applySgr(attr, args.toString())
                            break
                        }
                        args.append(f)
                        j++
                    }
                    i = if (j < n) j + 1 else n
                } else {
                    // Non-CSI escape (e.g. ESC c, ESC (B): skip ESC + one byte;
                    // for '(' / ')' / '#' consume the designator byte too.
                    i += if (next == '(' || next == ')' || next == '#') 3 else 2
                }
            } else {
                out.add(AnsiCell(c, attr))
                i++
            }
        }
        return out
    }

    /** Collapse cells into styled spans for rendering. */
    fun parseSpans(line: String, base: AnsiAttr = AnsiAttr.DEFAULT): List<AnsiSpan> {
        val cells = parseCells(line, base)
        if (cells.isEmpty()) return emptyList()
        val spans = ArrayList<AnsiSpan>()
        var cur = cells[0].attr
        val sb = StringBuilder()
        for (cell in cells) {
            if (cell.attr != cur) {
                spans.add(AnsiSpan(sb.toString(), cur))
                sb.clear()
                cur = cell.attr
            }
            sb.append(cell.char)
        }
        spans.add(AnsiSpan(sb.toString(), cur))
        return spans
    }

    private fun applySgr(attr: AnsiAttr, args: String): AnsiAttr {
        val codes = if (args.isEmpty()) intArrayOf(0)
        else args.split(';').map { it.toIntOrNull() ?: 0 }.toIntArray()
        var a = attr
        var i = 0
        while (i < codes.size) {
            when (val code = codes[i]) {
                0 -> a = AnsiAttr.DEFAULT
                1 -> a = a.copy(bold = true, dim = false)
                2 -> a = a.copy(dim = true)
                3 -> a = a.copy(italic = true)
                4 -> a = a.copy(underline = true)
                5, 6 -> Unit // blink ignored
                7 -> a = a.copy(inverse = true)
                9 -> a = a.copy(strike = true)
                21, 22 -> a = a.copy(bold = false, dim = false)
                23 -> a = a.copy(italic = false)
                24 -> a = a.copy(underline = false)
                27 -> a = a.copy(inverse = false)
                29 -> a = a.copy(strike = false)
                in 30..37 -> a = a.copy(fg = standardColor(code - 30, a.bold))
                38 -> {
                    extendedColor(codes, i + 1)?.let { (color, next) ->
                        a = a.copy(fg = color)
                        i = next
                    }
                }
                39 -> a = a.copy(fg = -1)
                in 40..47 -> a = a.copy(bg = standardColor(code - 40, bright = false))
                48 -> {
                    extendedColor(codes, i + 1)?.let { (color, next) ->
                        a = a.copy(bg = color)
                        i = next
                    }
                }
                49 -> a = a.copy(bg = -1)
                in 90..97 -> a = a.copy(fg = standardColor(code - 90, bright = true))
                in 100..107 -> a = a.copy(bg = standardColor(code - 100, bright = true))
                else -> Unit
            }
            i++
        }
        return a
    }

    /** Returns (argb, lastConsumedIndex) for `38;5;n` / `38;2;r;g;b` forms. */
    private fun extendedColor(codes: IntArray, start: Int): Pair<Int, Int>? {
        if (start >= codes.size) return null
        return when (codes[start]) {
            5 -> if (start + 1 < codes.size)
                indexedColor(codes[start + 1].coerceIn(0, 255)) to start + 1
            else null
            2 -> if (start + 3 < codes.size)
                rgb(
                    codes[start + 1].coerceIn(0, 255),
                    codes[start + 2].coerceIn(0, 255),
                    codes[start + 3].coerceIn(0, 255),
                ) to start + 3
            else null
            else -> null
        }
    }

    private fun rgb(r: Int, g: Int, b: Int): Int =
        (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    private fun standardColor(index: Int, bright: Boolean): Int {
        val base = intArrayOf(
            0xFF000000.toInt(), 0xFFCD3131.toInt(), 0xFF0DBC79.toInt(), 0xFFE5E510.toInt(),
            0xFF2472C8.toInt(), 0xFFBC3FBC.toInt(), 0xFF11A8CD.toInt(), 0xFFE5E5E5.toInt(),
        )
        val bright_ = intArrayOf(
            0xFF666666.toInt(), 0xFFF14C4C.toInt(), 0xFF23D18B.toInt(), 0xFFF5F543.toInt(),
            0xFF3B8EEA.toInt(), 0xFFD670D6.toInt(), 0xFF29B8DB.toInt(), 0xFFFFFFFF.toInt(),
        )
        val i = index.coerceIn(0, 7)
        return if (bright) bright_[i] else base[i]
    }

    /** xterm 256-color palette: 0-15 standard, 16-231 cube, 232-255 grayscale. */
    private fun indexedColor(i: Int): Int {
        if (i < 16) {
            val base = intArrayOf(
                0xFF000000.toInt(), 0xFFCD3131.toInt(), 0xFF0DBC79.toInt(), 0xFFE5E510.toInt(),
                0xFF2472C8.toInt(), 0xFFBC3FBC.toInt(), 0xFF11A8CD.toInt(), 0xFFE5E5E5.toInt(),
                0xFF666666.toInt(), 0xFFF14C4C.toInt(), 0xFF23D18B.toInt(), 0xFFF5F543.toInt(),
                0xFF3B8EEA.toInt(), 0xFFD670D6.toInt(), 0xFF29B8DB.toInt(), 0xFFFFFFFF.toInt(),
            )
            return base[i]
        }
        if (i < 232) {
            val v = i - 16
            val r = cubeLevel(v / 36)
            val g = cubeLevel((v % 36) / 6)
            val b = cubeLevel(v % 6)
            return rgb(r, g, b)
        }
        val level = 8 + (i - 232) * 10
        return rgb(level, level, level)
    }

    private fun cubeLevel(i: Int): Int = if (i == 0) 0 else 55 + i * 40

    fun toColor(argb: Int, fallback: Color): Color =
        if (argb == -1) fallback else Color(argb)
}
