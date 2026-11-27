package app.shelfmark.reader.reader

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.res.AssetManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import app.shelfmark.reader.epub.EpubBook
import java.io.ByteArrayInputStream
import java.nio.charset.Charset
import org.json.JSONObject

/**
 * The book is shown by a web view that never touches the network. Two made-up
 * addresses are answered by the app itself:
 *
 *   https://book.invalid/<path>    a file out of the epub
 *   https://reader.invalid/<path>  the reader's own script, styles and typefaces
 *
 * Anything else a book asks for gets an empty answer.
 */
const val BOOK_HOST = "book.invalid"
const val READER_HOST = "reader.invalid"

/** What is added to the head of every chapter. Written so that it is valid in XHTML and in HTML. */
private const val INJECTED =
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>" +
        "<link rel=\"stylesheet\" type=\"text/css\" href=\"https://$READER_HOST/reader.css\"/>" +
        "<script type=\"text/javascript\" src=\"https://$READER_HOST/reader.js\"></script>"

/** Only the reader's own script may run: scripts that come with a book are left out. */
private const val POLICY = "script-src https://$READER_HOST; object-src 'none'"

/** What the page can reach of the app, as `ShelfmarkHost`. Called on a thread of the web view's own. */
class PageBridge(private val onEvent: (String, JSONObject) -> Unit) {
    /** The settings and the place to start at, for the chapter that is being loaded. */
    @Volatile
    var pending: String = "{}"
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun config(): String = pending

    @JavascriptInterface
    fun event(name: String, json: String) {
        val data = try {
            JSONObject(json)
        } catch (e: Exception) {
            JSONObject()
        }
        main.post { onEvent(name, data) }
    }
}

class BookClient(
    private val book: EpubBook,
    private val assets: AssetManager,
    /** Chapters that are not well-formed XML and are read as HTML instead. */
    private val lenient: Set<String>,
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != BOOK_HOST

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val path = (request.url.path ?: "").trimStart('/')
        return try {
            when (request.url.host) {
                READER_HOST -> readerFile(path)
                BOOK_HOST -> bookFile(path, request.isForMainFrame)
                else -> null
            } ?: nothing()
        } catch (e: Exception) {
            nothing()
        }
    }

    private fun nothing() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

    private fun readerFile(path: String): WebResourceResponse? {
        if (path.contains("..")) return null
        val type = when (path.substringAfterLast('.', "")) {
            "css" -> "text/css"
            "js" -> "text/javascript"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            else -> return null
        }
        val stream = assets.open("reader/$path")
        // Typefaces are asked for by the chapter's page, which is another address: that has to be allowed.
        return WebResourceResponse(
            type, if (type.startsWith("text/")) "utf-8" else null, 200, "OK",
            // They only change with the app, so the web view may keep them between chapters.
            mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "max-age=86400"), stream,
        )
    }

    private fun bookFile(path: String, mainFrame: Boolean): WebResourceResponse? {
        val index = book.indexOf(path)
        if (index < 0 || !mainFrame) {
            val stream = book.open(path) ?: return null
            val type = book.typeOf(path)
            return WebResourceResponse(type, if (type.startsWith("text/") || type.endsWith("xml")) "utf-8" else null, stream)
        }
        // A chapter: the reader's script and styles go into its head.
        val item = book.spine[index]
        var text = decode(book.read(item.path) ?: return null)
        var type = if (item.mediaType == "text/html" || item.path.endsWith(".html", true) || item.path.endsWith(".htm", true)) "text/html" else "application/xhtml+xml"
        if (item.path in lenient) {
            type = "text/html"
            text = SELF_CLOSED.replace(text) { m -> "<${m.groupValues[1]}${m.groupValues[2]}></${m.groupValues[1]}>" }
        }
        text = inject(text)
        return WebResourceResponse(
            type, "utf-8", 200, "OK",
            mapOf("Cache-Control" to "no-store", "Content-Security-Policy" to POLICY),
            ByteArrayInputStream(text.toByteArray(Charsets.UTF_8)),
        )
    }

    companion object {
        private val HEAD = Regex("<head(\\s[^>]*)?>", RegexOption.IGNORE_CASE)
        private val HTML = Regex("<html(\\s[^>]*)?>", RegexOption.IGNORE_CASE)
        private val XML_ENCODING = Regex("(<\\?xml[^>]*encoding=[\"'])[^\"']+([\"'])")
        // Tags that swallow the rest of the page when HTML meets them written as <tag/>.
        private val SELF_CLOSED = Regex(
            "<(title|script|style|a|div|span|p|i|b|em|strong|h[1-6]|td|th|li|ul|ol|table|section|sup|sub|small|blockquote|textarea|iframe)\\b([^<>]*?)/>",
            RegexOption.IGNORE_CASE,
        )

        fun inject(text: String): String {
            HEAD.find(text)?.let { return text.substring(0, it.range.last + 1) + INJECTED + text.substring(it.range.last + 1) }
            HTML.find(text)?.let { return text.substring(0, it.range.last + 1) + "<head>$INJECTED</head>" + text.substring(it.range.last + 1) }
            return INJECTED + text
        }

        /** The chapter as text, whatever it was saved as. It is sent on as UTF-8. */
        fun decode(bytes: ByteArray): String {
            fun at(i: Int) = if (i < bytes.size) bytes[i].toInt() and 0xFF else -1
            val text = when {
                at(0) == 0xEF && at(1) == 0xBB && at(2) == 0xBF -> String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
                at(0) == 0xFE && at(1) == 0xFF -> String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
                at(0) == 0xFF && at(1) == 0xFE -> String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
                else -> {
                    val head = String(bytes, 0, minOf(bytes.size, 200), Charsets.ISO_8859_1)
                    val named = Regex("encoding=[\"']([\\w.:-]+)[\"']").find(head)?.groupValues?.get(1)
                    val charset = named?.let { runCatching { Charset.forName(it) }.getOrNull() } ?: Charsets.UTF_8
                    String(bytes, charset)
                }
            }
            return XML_ENCODING.replaceFirst(text, "$1utf-8$2")
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
fun createBookView(context: Context, book: EpubBook, bridge: PageBridge, lenient: Set<String>): WebView {
    val view = WebView(context)
    // Without this a web view is as tall as what it shows, and a page is as tall as its view: one line.
    view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
        // In a build for trying things out, the page can be looked into from a computer (chrome://inspect),
        // and what it writes to its console shows up in the phone's log.
        WebView.setWebContentsDebuggingEnabled(true)
        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("ShelfmarkPage", "${message.message()} (${message.sourceId().substringAfterLast('/')}:${message.lineNumber()})")
                return true
            }
        }
    }
    view.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = false
        allowFileAccess = false
        allowContentAccess = false
        setSupportZoom(false)
        builtInZoomControls = false
        displayZoomControls = false
        mediaPlaybackRequiresUserGesture = true
        setGeolocationEnabled(false)
    }
    view.isVerticalScrollBarEnabled = false
    view.isHorizontalScrollBarEnabled = false
    view.overScrollMode = View.OVER_SCROLL_NEVER
    view.addJavascriptInterface(bridge, "ShelfmarkHost")
    view.webViewClient = BookClient(book, context.assets, lenient)
    return view
}
