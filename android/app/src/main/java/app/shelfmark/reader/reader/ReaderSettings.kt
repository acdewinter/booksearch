package app.shelfmark.reader.reader

import android.content.Context
import org.json.JSONObject

/** The colours of a page. `flat`, `ink` and `dim` say how far the book's own colours are overruled. */
data class ReaderTheme(
    val id: String,
    val label: String,
    val background: Long,
    val text: Long,
    val link: Long,
    /** Drop the book's own background colours. */
    val flat: Boolean,
    /** Drop the book's own text colours. */
    val ink: Boolean,
    /** Turn pictures down a little. */
    val dim: Boolean,
    /** Take the blue out of everything on screen. */
    val noBlue: Boolean = false,
) {
    val dark: Boolean get() = ink
}

val THEMES = listOf(
    ReaderTheme("light", "Light", 0xFFFBFAF7, 0xFF1C1C1A, 0xFF1D5B4D, flat = false, ink = false, dim = false),
    ReaderTheme("stone", "Stone", 0xFFDCD8CF, 0xFF2A2926, 0xFF2F5D50, flat = true, ink = false, dim = false),
    ReaderTheme("dark", "Dark", 0xFF121416, 0xFFC4C7C5, 0xFF7CCDB3, flat = true, ink = true, dim = true),
    ReaderTheme("night", "Night", 0xFF000000, 0xFFD9A066, 0xFFE8B880, flat = true, ink = true, dim = true, noBlue = true),
)

/** A typeface to read in. `css` is what the page is told; empty means the book's own. */
data class ReaderFont(val id: String, val label: String, val css: String)

val FONTS = listOf(
    ReaderFont("book", "Book's own", ""),
    // These three come with the app (see assets/reader/fonts).
    ReaderFont("literata", "Literata", "\"Literata\", serif"),
    ReaderFont("bitter", "Bitter", "\"Bitter\", serif"),
    ReaderFont("atkinson", "Atkinson", "\"Atkinson Hyperlegible Next\", sans-serif"),
    ReaderFont("grotesque", "Grotesque", "\"Shelfmark Grotesque\", sans-serif"),
    // And these are the phone's own.
    ReaderFont("serif", "Phone serif", "serif"),
    ReaderFont("sans", "Phone sans", "sans-serif"),
    ReaderFont("slab", "Typewriter", "\"serif-monospace\", \"Cutive Mono\", monospace"),
    ReaderFont("mono", "Mono", "monospace"),
)

data class ReaderSettings(
    val theme: String = "light",
    val font: String = "book",
    /** Text size, as a multiple of the book's own. */
    val fontScale: Float = 1.0f,
    /** 0 leaves the line spacing to the book. */
    val lineHeight: Float = 0f,
    /** "book", "justify" or "left" */
    val align: String = "book",
    /** Space at the sides of the text, in dp. */
    val margin: Int = 22,
    /** Paragraphs set apart by space instead of an indent. */
    val spaced: Boolean = false,
    val slide: Boolean = true,
    /** "sides" (left goes back), "forward" (both sides go on) or "off" */
    val taps: String = "sides",
    val volumeKeys: Boolean = true,
    val keepAwake: Boolean = true,
    val footer: Boolean = true,
    /** Screen brightness while reading, 0.01 to 1; below 0 leaves it to the phone. */
    val brightness: Float = -1f,
    /** How much blue is taken out, 0 to 1, in the themes that do not take all of it out. */
    val warmth: Float = 0f,
) {
    val themeColors: ReaderTheme get() = THEMES.firstOrNull { it.id == theme } ?: THEMES[0]
    val fontCss: String get() = FONTS.firstOrNull { it.id == font }?.css ?: ""

    /** How much blue is taken out with these settings. */
    val blueCut: Float get() = if (themeColors.noBlue) 1f else warmth.coerceIn(0f, 1f)

    fun toJson(): JSONObject = JSONObject()
        .put("theme", theme).put("font", font).put("fontScale", fontScale.toDouble()).put("lineHeight", lineHeight.toDouble())
        .put("align", align).put("margin", margin).put("spaced", spaced).put("slide", slide).put("taps", taps)
        .put("volumeKeys", volumeKeys).put("keepAwake", keepAwake).put("footer", footer)
        .put("brightness", brightness.toDouble()).put("warmth", warmth.toDouble())

    /**
     * What the page is told. Sizes are in CSS pixels, which are the same as dp here.
     * @param top    room above the text (the camera cut-out and a little air)
     * @param bottom room below it (the line that says where you are)
     */
    fun forPage(top: Int, bottom: Int, language: String): JSONObject {
        val t = themeColors
        return JSONObject()
            .put("bg", css(t.background)).put("fg", css(t.text)).put("link", css(t.link))
            .put("select", if (t.dark) "rgba(217,160,102,0.35)" else "rgba(29,91,77,0.25)")
            .put("flat", t.flat).put("ink", t.ink).put("dim", t.dim)
            .put("font", fontCss)
            .put("lineHeight", lineHeight.toDouble())
            .put("align", align)
            .put("spaced", spaced)
            .put("side", margin).put("top", top).put("bottom", bottom)
            .put("slide", slide)
            .put("taps", taps)
            .put("lang", language)
    }

    companion object {
        private const val PREFS = "reader"
        private const val KEY = "settings"

        fun css(color: Long): String = String.format("#%06x", color and 0xFFFFFF)

        fun load(context: Context): ReaderSettings {
            val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return ReaderSettings()
            return try {
                val o = JSONObject(saved)
                val d = ReaderSettings()
                ReaderSettings(
                    theme = o.optString("theme", d.theme),
                    font = o.optString("font", d.font),
                    fontScale = o.optDouble("fontScale", d.fontScale.toDouble()).toFloat().coerceIn(0.6f, 3f),
                    lineHeight = o.optDouble("lineHeight", d.lineHeight.toDouble()).toFloat(),
                    align = o.optString("align", d.align),
                    margin = o.optInt("margin", d.margin).coerceIn(4, 60),
                    spaced = o.optBoolean("spaced", d.spaced),
                    slide = o.optBoolean("slide", d.slide),
                    taps = o.optString("taps", d.taps),
                    volumeKeys = o.optBoolean("volumeKeys", d.volumeKeys),
                    keepAwake = o.optBoolean("keepAwake", d.keepAwake),
                    footer = o.optBoolean("footer", d.footer),
                    brightness = o.optDouble("brightness", d.brightness.toDouble()).toFloat(),
                    warmth = o.optDouble("warmth", d.warmth.toDouble()).toFloat(),
                )
            } catch (e: Exception) {
                ReaderSettings()
            }
        }

        fun save(context: Context, settings: ReaderSettings) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, settings.toJson().toString()).apply()
        }
    }
}
