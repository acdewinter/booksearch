package app.shelfmark.reader.reader

import android.content.Context
import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.shelfmark.reader.data.Book
import app.shelfmark.reader.data.Library
import app.shelfmark.reader.data.Progress
import app.shelfmark.reader.epub.EpubBook
import app.shelfmark.reader.epub.TocEntry
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

enum class Panel { None, Settings, Contents }

/** Something the reader is told or asked, in a strip at the bottom of the page. */
sealed class Notice {
    /** The book was read further on another device. */
    data class Elsewhere(val progress: Progress) : Notice()
    data class Link(val url: String) : Notice()
    data class Text(val text: String) : Notice()
}

/**
 * One open book: which chapter is in the web view, which page of it, and the
 * settings it is shown with. The page itself is run by reader.js; this class
 * tells it where to start and hears from it where the reader is.
 */
class ReaderState(
    private val context: Context,
    val book: Book,
    val epub: EpubBook,
    private val scope: CoroutineScope,
) {
    var settings by mutableStateOf(ReaderSettings.load(context))
        private set
    var spine by mutableIntStateOf(0)
        private set
    var page by mutableIntStateOf(0)
        private set
    var pages by mutableIntStateOf(1)
        private set
    /** How much of the whole book is behind the reader, 0 to 1. */
    var fraction by mutableDoubleStateOf(0.0)
        private set
    var loading by mutableStateOf(true)
        private set
    var chrome by mutableStateOf(false)
        private set
    var panel by mutableStateOf(Panel.None)
        private set
    var notice by mutableStateOf<Notice?>(null)
    /** Where the reader was before following a link, to go back to. */
    var returnTo by mutableStateOf<Pair<Int, Double>?>(null)
        private set

    val chapterTitle: String get() = epub.chapterTitle(spine)

    private var web: WebView? = null
    private val bridge = PageBridge(::onEvent)
    private val lenient = HashSet<String>()
    private var gen = 0
    private var inner = 0.0
    private var top = 30
    private var bottom = 40
    private var lastStart = JSONObject().put("kind", "start")
    /** The chapter being loaded was asked for by the reader (a page turn, a link), not just restored. */
    private var movedByReader = false
    private var saveJob: Job? = null
    private var pushJob: Job? = null
    private var started = false

    fun createView(context: Context): WebView {
        val view = createBookView(context, epub, bridge, lenient)
        view.setBackgroundColor(settings.themeColors.background.toInt())
        view.settings.textZoom = (settings.fontScale * 100).toInt()
        // Asked for a second time (the screen was put together again): the old view makes way for this one.
        web?.let { old -> discard(old) }
        web = view
        if (!started) {
            started = true
            openWhereLeft()
        } else {
            load(spine, JSONObject().put("kind", "inner").put("value", inner))
        }
        return view
    }

    /** Start at the place this phone (or, failing that, the server) remembers. */
    private fun openWhereLeft() {
        val known = Library.progress[book.file.id]
        when {
            known == null || known.fraction <= 0.0 -> load(0, JSONObject().put("kind", "start"))
            known.spine in epub.spine.indices -> load(known.spine, JSONObject().put("kind", "inner").put("value", known.inner))
            else -> {
                val (index, within) = epub.locate(known.fraction)
                load(index, JSONObject().put("kind", "inner").put("value", within))
            }
        }
        fraction = known?.fraction ?: 0.0
        // Was it read further somewhere else in the meantime?
        scope.launch {
            val remote = Library.newerElsewhere(book.file.id) ?: return@launch
            if (abs(remote.fraction - fraction) > 0.004) notice = Notice.Elsewhere(remote)
        }
    }

    // ----------------------------------------------------------------- loading

    private fun load(index: Int, start: JSONObject) {
        val i = index.coerceIn(0, epub.spine.size - 1)
        spine = i
        loading = true
        lastStart = start
        gen += 1
        val mine = gen
        bridge.pending = JSONObject()
            .put("gen", gen)
            .put("settings", settings.forPage(top, bottom, epub.language))
            .put("start", start)
            .toString()
        val path = epub.spine[i].path
        web?.loadUrl(Uri.Builder().scheme("https").authority(BOOK_HOST).path("/$path").build().toString())
        // A chapter that never reports in is tried once more, read more forgivingly; after that it is shown as it is.
        scope.launch {
            delay(6000)
            if (gen != mine || !loading) return@launch
            if (lenient.add(path)) {
                load(i, start)
            } else {
                js("document.documentElement.classList.add('sm-ready')")
                loading = false
            }
        }
    }

    private fun js(code: String) {
        web?.evaluateJavascript("try{$code}catch(e){}", null)
    }

    private fun onEvent(name: String, data: JSONObject) {
        if (data.optInt("gen") != gen) return
        when (name) {
            "ready", "page" -> {
                page = data.optInt("page")
                pages = data.optInt("pages", 1).coerceAtLeast(1)
                inner = data.optDouble("inner", 0.0)
                val seen = data.optDouble("seen", 0.0)
                if (name == "ready") {
                    loading = false
                    js("Shelfmark.setChrome(${chrome || panel != Panel.None})")
                }
                val moved = if (name == "ready") movedByReader else data.optBoolean("moved")
                if (name == "ready") movedByReader = false
                if (moved) {
                    fraction = epub.fractionAt(spine, seen)
                    remember()
                } else if (fraction <= 0.0) {
                    fraction = epub.fractionAt(spine, seen)
                }
            }
            "edge" -> {
                if (loading) return
                val dir = data.optInt("dir", 1)
                val next = spine + dir
                if (next !in epub.spine.indices) {
                    if (dir > 0) notice = Notice.Text("That was the last page.")
                    return
                }
                movedByReader = true
                load(next, JSONObject().put("kind", if (dir < 0) "end" else "start"))
            }
            "tap" -> {
                if (panel != Panel.None) showPanel(Panel.None) else showChrome(!chrome)
            }
            "link" -> {
                val index = epub.indexOf(data.optString("path").trimStart('/'))
                if (index < 0) return
                returnTo = spine to inner
                movedByReader = true
                val hash = data.optString("hash")
                load(index, if (hash.isEmpty()) JSONObject().put("kind", "start") else JSONObject().put("kind", "anchor").put("value", hash))
            }
            "jumped" -> returnTo = spine to data.optDouble("from", 0.0)
            "external" -> notice = Notice.Link(data.optString("url"))
            "xmlerror" -> {
                if (lenient.add(epub.spine[spine].path)) load(spine, lastStart)
            }
        }
    }

    // ------------------------------------------------------------------ moving

    /** Turn a page: 1 forward, -1 back. */
    fun turn(direction: Int) {
        if (!loading) js("Shelfmark.turn($direction)")
    }

    /** Go to a place in the whole book, 0 to 1. */
    fun seek(target: Double) {
        val (index, within) = epub.locate(target)
        goTo(index, within)
    }

    private fun goTo(index: Int, within: Double) {
        if (index == spine && !loading) {
            js("Shelfmark.goTo($within)")
        } else {
            movedByReader = true
            load(index, JSONObject().put("kind", "inner").put("value", within))
        }
    }

    fun open(entry: TocEntry) {
        val index = epub.indexOf(entry.path)
        if (index < 0) return
        showPanel(Panel.None)
        showChrome(false)
        if (index == spine && !loading && entry.fragment.isNotEmpty()) {
            js("Shelfmark.goToAnchor(${JSONObject.quote(entry.fragment)})")
        } else {
            movedByReader = true
            load(index, if (entry.fragment.isEmpty()) JSONObject().put("kind", "start") else JSONObject().put("kind", "anchor").put("value", entry.fragment))
        }
    }

    fun goBack() {
        val (index, within) = returnTo ?: return
        returnTo = null
        goTo(index, within)
    }

    /** Take up the place the book was read to on another device. */
    fun follow(progress: Progress) {
        notice = null
        if (progress.spine in epub.spine.indices) goTo(progress.spine, progress.inner) else seek(progress.fraction)
    }

    // ------------------------------------------------------------- appearance

    fun showChrome(on: Boolean) {
        chrome = on
        js("Shelfmark.setChrome(${on || panel != Panel.None})")
    }

    fun showPanel(which: Panel) {
        panel = which
        js("Shelfmark.setChrome(${chrome || which != Panel.None})")
    }

    /** The room the page leaves above and below the text, in dp. */
    fun setInsets(newTop: Int, newBottom: Int) {
        if (newTop == top && newBottom == bottom) return
        top = newTop
        bottom = newBottom
        pushSettings()
    }

    fun update(change: (ReaderSettings) -> ReaderSettings) {
        val next = change(settings)
        if (next == settings) return
        val zoomed = next.fontScale != settings.fontScale
        settings = next
        ReaderSettings.save(context, next)
        web?.setBackgroundColor(next.themeColors.background.toInt())
        if (zoomed) web?.settings?.textZoom = (next.fontScale * 100).toInt()
        pushSettings()
        if (zoomed) {
            // The new size reaches the page a moment later than this call does.
            scope.launch {
                delay(160)
                js("Shelfmark.relayout()")
                delay(350)
                js("Shelfmark.relayout()")
            }
        }
    }

    private fun pushSettings() {
        if (loading) {
            // Still on its way in: it will ask for the settings itself, so give it the new ones.
            bridge.pending = JSONObject(bridge.pending).put("settings", settings.forPage(top, bottom, epub.language)).toString()
        }
        js("Shelfmark.apply(${JSONObject.quote(settings.forPage(top, bottom, epub.language).toString())})")
    }

    // --------------------------------------------------------------- progress

    private fun remember() {
        Library.setProgress(book.file.id, fraction, spine, inner, chapterTitle)
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(1500)
            Library.persist()
        }
        if (pushJob?.isActive != true) {
            pushJob = scope.launch {
                delay(20_000)
                Library.pushProgress()
            }
        }
    }

    /** The book is being put away (or the app left): save now, and tell the server. */
    fun flush() {
        saveJob?.cancel()
        pushJob?.cancel()
        Library.persist()
        Library.scope.launch { Library.pushProgress() }
    }

    fun close() {
        flush()
        gen += 1
        web?.let { discard(it) }
        web = null
        epub.close()
    }

    private fun discard(view: WebView) {
        view.stopLoading()
        view.removeJavascriptInterface("ShelfmarkHost")
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }
}
