package app.shelfmark.reader.epub

import android.util.Xml
import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.net.URLDecoder
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import org.xmlpull.v1.XmlPullParser

/** One document of the book, in reading order. `path` is its name inside the zip. */
data class SpineItem(val path: String, val mediaType: String, val size: Long)

/** One line of the table of contents. */
data class TocEntry(val title: String, val path: String, val fragment: String, val depth: Int)

class EpubException(message: String) : Exception(message)

/**
 * An epub that is open for reading.
 *
 * An epub is a zip. META-INF/container.xml names the "package" file; that
 * lists every file in the book (the manifest) and the order the chapters are
 * read in (the spine). The table of contents is a file of its own: nav.xhtml
 * in EPUB 3, toc.ncx in EPUB 2.
 */
class EpubBook(file: File) : Closeable {
    private val zip: ZipFile = try {
        ZipFile(file)
    } catch (e: Exception) {
        throw EpubException("This file is not an epub that can be opened.")
    }
    private val byLowerName: Map<String, String> = zip.entries().asSequence().filter { !it.isDirectory }.associate { it.name.lowercase() to it.name }

    var title: String = ""
        private set
    var author: String = ""
        private set
    var language: String = ""
        private set
    val spine: List<SpineItem>
    val toc: List<TocEntry>
    private val types = HashMap<String, String>()   // path -> media type
    private val spineIndex = HashMap<String, Int>() // path -> place in the spine
    private val before: LongArray                   // bytes of text before each spine item
    val totalSize: Long

    init {
        try {
            val container = entry("META-INF/container.xml") ?: throw EpubException("This file is not an epub: its table of contents is missing.")
            var packagePath = ""
            parse(zip.getInputStream(container)) { p ->
                if (p.eventType == XmlPullParser.START_TAG && local(p.name) == "rootfile" && packagePath.isEmpty()) {
                    packagePath = p.getAttributeValue(null, "full-path") ?: ""
                }
            }
            val packageEntry = entry(packagePath) ?: throw EpubException("This file is not an epub: its package file is missing.")
            val base = packageEntry.name.substringBeforeLast('/', "")

            data class Item(val id: String, val path: String, val type: String, val properties: String)
            val items = LinkedHashMap<String, Item>()
            val order = ArrayList<String>()
            var ncxId = ""
            var inMetadata = false
            var capture = ""
            val text = StringBuilder()
            parse(zip.getInputStream(packageEntry)) { p ->
                when (p.eventType) {
                    XmlPullParser.START_TAG -> when (local(p.name)) {
                        "metadata" -> inMetadata = true
                        "title", "creator", "language" -> if (inMetadata) {
                            capture = local(p.name)
                            text.setLength(0)
                        }
                        "item" -> {
                            val id = p.getAttributeValue(null, "id") ?: ""
                            val href = p.getAttributeValue(null, "href") ?: ""
                            if (href.isNotEmpty()) {
                                items[id] = Item(id, resolve(base, href), p.getAttributeValue(null, "media-type") ?: "", p.getAttributeValue(null, "properties") ?: "")
                            }
                        }
                        "spine" -> ncxId = p.getAttributeValue(null, "toc") ?: ""
                        "itemref" -> p.getAttributeValue(null, "idref")?.let { order.add(it) }
                    }
                    XmlPullParser.TEXT -> if (capture.isNotEmpty()) text.append(p.text)
                    XmlPullParser.END_TAG -> {
                        val name = local(p.name)
                        if (name == "metadata") inMetadata = false
                        if (name == capture) {
                            val value = text.toString().trim().replace(Regex("\\s+"), " ")
                            when (capture) {
                                "title" -> if (title.isEmpty()) title = value
                                "creator" -> if (author.isEmpty()) author = value
                                "language" -> if (language.isEmpty()) language = value
                            }
                            capture = ""
                        }
                    }
                }
            }

            for (item in items.values) types[item.path] = item.type
            val found = ArrayList<SpineItem>()
            for (id in order) {
                val item = items[id] ?: continue
                val e = entry(item.path) ?: continue
                found.add(SpineItem(e.name, item.type.ifEmpty { "application/xhtml+xml" }, e.size.coerceAtLeast(1L)))
            }
            if (found.isEmpty()) throw EpubException("This epub has no chapters to read.")
            spine = found
            spine.forEachIndexed { i, s -> spineIndex[s.path] = i }
            before = LongArray(spine.size)
            var sum = 0L
            spine.forEachIndexed { i, s ->
                before[i] = sum
                sum += s.size
            }
            totalSize = sum

            // The table of contents: EPUB 3's nav document if it can be read, else EPUB 2's NCX.
            var contents: List<TocEntry> = emptyList()
            items.values.firstOrNull { it.properties.split(' ').contains("nav") }?.let { nav ->
                contents = runCatching { readNav(nav.path) }.getOrDefault(emptyList())
            }
            if (contents.isEmpty()) {
                val ncx = items[ncxId] ?: items.values.firstOrNull { it.type == "application/x-dtbncx+xml" }
                if (ncx != null) contents = runCatching { readNcx(ncx.path) }.getOrDefault(emptyList())
            }
            toc = contents.filter { spineIndex.containsKey(it.path) }
        } catch (e: EpubException) {
            zip.close()
            throw e
        } catch (e: Exception) {
            zip.close()
            throw EpubException("This epub could not be read.")
        }
    }

    // ------------------------------------------------------------------ files

    private fun entry(path: String): ZipEntry? {
        if (path.isEmpty()) return null
        return zip.getEntry(path) ?: byLowerName[path.lowercase()]?.let { zip.getEntry(it) }
    }

    fun has(path: String): Boolean = entry(path) != null

    fun open(path: String): InputStream? = entry(path)?.let { zip.getInputStream(it) }

    fun read(path: String): ByteArray? = open(path)?.use { it.readBytes() }

    /** The media type the book itself gives a file, or a guess from its name. */
    fun typeOf(path: String): String {
        val declared = types[path] ?: types.entries.firstOrNull { it.key.equals(path, ignoreCase = true) }?.value
        if (!declared.isNullOrEmpty()) return declared
        return when (path.substringAfterLast('.', "").lowercase()) {
            "xhtml", "xht" -> "application/xhtml+xml"
            "html", "htm" -> "text/html"
            "css" -> "text/css"
            "js" -> "text/javascript"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "svg" -> "image/svg+xml"
            "webp" -> "image/webp"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "mp3" -> "audio/mpeg"
            "mp4", "m4v" -> "video/mp4"
            else -> "application/octet-stream"
        }
    }

    /** Where in the reading order a file is, or -1 when it is not a chapter. */
    fun indexOf(path: String): Int {
        spineIndex[path]?.let { return it }
        return spine.indexOfFirst { it.path.equals(path, ignoreCase = true) }
    }

    // --------------------------------------------------------------- progress

    /** How much of the book is behind a reader who is `seen` (0 to 1) of the way through chapter `index`. */
    fun fractionAt(index: Int, seen: Double): Double {
        if (index !in spine.indices || totalSize <= 0) return 0.0
        return ((before[index] + spine[index].size * seen.coerceIn(0.0, 1.0)) / totalSize).coerceIn(0.0, 1.0)
    }

    /** The chapter, and the place inside it (0 to 1), that lies `fraction` of the way through the book. */
    fun locate(fraction: Double): Pair<Int, Double> {
        val target = (fraction.coerceIn(0.0, 1.0) * totalSize).toLong()
        var index = spine.indices.lastOrNull { before[it] <= target } ?: 0
        index = index.coerceIn(0, spine.size - 1)
        val inner = ((target - before[index]).toDouble() / spine[index].size).coerceIn(0.0, 0.9999)
        return index to inner
    }

    /** The heading of the part of the book that chapter `index` belongs to. */
    fun chapterTitle(index: Int): String {
        var best = ""
        var bestAt = -1
        for (entry in toc) {
            val at = indexOf(entry.path)
            if (at in 0..index && at > bestAt) {
                best = entry.title
                bestAt = at
            }
        }
        return best
    }

    /** The line of the table of contents the reader is in, for marking it. */
    fun currentTocIndex(index: Int): Int {
        var best = -1
        toc.forEachIndexed { i, entry ->
            val at = indexOf(entry.path)
            if (at in 0..index) best = i
        }
        return best
    }

    // ----------------------------------------------------- table of contents

    private fun readNcx(path: String): List<TocEntry> {
        val base = path.substringBeforeLast('/', "")
        val out = ArrayList<TocEntry>()
        var depth = 0
        var label: StringBuilder? = null
        var pendingTitle = ""
        var inLabel = false
        parse(open(path) ?: return out) { p ->
            when (p.eventType) {
                XmlPullParser.START_TAG -> when (local(p.name)) {
                    "navPoint" -> {
                        depth += 1
                        pendingTitle = ""
                    }
                    "navLabel" -> inLabel = true
                    "text" -> if (inLabel && depth > 0) label = StringBuilder()
                    "content" -> if (depth > 0) {
                        val src = p.getAttributeValue(null, "src") ?: ""
                        if (src.isNotEmpty()) {
                            out.add(TocEntry(pendingTitle.ifEmpty { "Untitled" }, resolve(base, src.substringBefore('#')), src.substringAfter('#', ""), depth - 1))
                        }
                    }
                }
                XmlPullParser.TEXT -> label?.append(p.text)
                XmlPullParser.END_TAG -> when (local(p.name)) {
                    "text" -> label?.let {
                        pendingTitle = it.toString().trim().replace(Regex("\\s+"), " ")
                        label = null
                    }
                    "navLabel" -> inLabel = false
                    "navPoint" -> depth -= 1
                }
            }
        }
        return out
    }

    private fun readNav(path: String): List<TocEntry> {
        val base = path.substringBeforeLast('/', "")
        val out = ArrayList<TocEntry>()
        var inToc = false
        var navDepth = 0   // how deep inside the toc <nav> the parser is
        var listDepth = 0
        var href: String? = null
        val text = StringBuilder()
        parse(open(path) ?: return out) { p ->
            when (p.eventType) {
                XmlPullParser.START_TAG -> {
                    val name = local(p.name)
                    if (name == "nav" && !inToc) {
                        val type = (0 until p.attributeCount).firstOrNull { local(p.getAttributeName(it)) == "type" }?.let { p.getAttributeValue(it) } ?: ""
                        if (type.split(' ').contains("toc") || type.isEmpty()) {
                            inToc = true
                            navDepth = 0
                        }
                    } else if (inToc) {
                        navDepth += 1
                        if (name == "ol" || name == "ul") listDepth += 1
                        if (name == "a") {
                            href = p.getAttributeValue(null, "href") ?: ""
                            text.setLength(0)
                        }
                    }
                }
                XmlPullParser.TEXT -> if (href != null) text.append(p.text)
                XmlPullParser.END_TAG -> {
                    val name = local(p.name)
                    if (inToc) {
                        if (name == "nav" && navDepth == 0) {
                            inToc = false
                        } else {
                            navDepth -= 1
                            if (name == "ol" || name == "ul") listDepth -= 1
                            if (name == "a") {
                                val link = href ?: ""
                                val title = text.toString().trim().replace(Regex("\\s+"), " ")
                                if (link.isNotEmpty() && title.isNotEmpty()) {
                                    out.add(TocEntry(title, resolve(base, link.substringBefore('#')), link.substringAfter('#', ""), (listDepth - 1).coerceAtLeast(0)))
                                }
                                href = null
                            }
                        }
                    }
                }
            }
        }
        return out
    }

    override fun close() {
        runCatching { zip.close() }
    }

    companion object {
        /** Makes the XML reader. Android's own; the tests, which run without Android, bring theirs. */
        var newParser: () -> XmlPullParser = { Xml.newPullParser() }

        private val ENTITIES = mapOf(
            "nbsp" to " ", "ensp" to " ", "emsp" to " ", "thinsp" to " ", "shy" to "",
            "mdash" to "—", "ndash" to "–", "hellip" to "…", "middot" to "·", "bull" to "•",
            "lsquo" to "‘", "rsquo" to "’", "ldquo" to "“", "rdquo" to "”", "laquo" to "«", "raquo" to "»",
            "copy" to "©", "reg" to "®", "trade" to "™", "deg" to "°", "times" to "×", "frac12" to "½",
            "eacute" to "é", "egrave" to "è", "ecirc" to "ê", "euml" to "ë", "aacute" to "á", "agrave" to "à",
            "acirc" to "â", "auml" to "ä", "aring" to "å", "ccedil" to "ç", "iacute" to "í", "iuml" to "ï",
            "ntilde" to "ñ", "oacute" to "ó", "ocirc" to "ô", "ouml" to "ö", "oslash" to "ø", "uacute" to "ú",
            "uuml" to "ü", "szlig" to "ß", "aelig" to "æ", "oelig" to "œ", "Eacute" to "É", "Ouml" to "Ö", "Uuml" to "Ü",
        )

        private fun local(name: String?): String = (name ?: "").substringAfter(':')

        /** Walk an XML file, calling `visit` at every tag and piece of text. */
        private fun parse(input: InputStream, visit: (XmlPullParser) -> Unit) {
            input.use { stream ->
                val parser = newParser()
                parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
                // The document type a file names is not fetched or read: nothing here depends on it.
                runCatching { parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false) }
                // Lets through what a strict reader would stop at, such as &nbsp; in a table of contents.
                runCatching { parser.setFeature("http://xmlpull.org/v1/doc/features.html#relaxed", true) }
                parser.setInput(stream, null)
                // Names XML itself does not know, but that tables of contents are full of.
                for ((name, text) in ENTITIES) runCatching { parser.defineEntityReplacementText(name, text) }
                while (true) {
                    val event = parser.next()
                    if (event == XmlPullParser.END_DOCUMENT) break
                    visit(parser)
                }
            }
        }

        /** Where a file named in another file really is inside the zip. */
        fun resolve(base: String, href: String): String {
            val decoded = try {
                URLDecoder.decode(href.replace("+", "%2B"), "UTF-8")
            } catch (e: Exception) {
                href
            }
            val parts = ArrayList<String>()
            val joined = if (decoded.startsWith("/")) decoded else if (base.isEmpty()) decoded else "$base/$decoded"
            for (part in joined.split('/')) {
                when (part) {
                    "", "." -> {}
                    ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
                    else -> parts.add(part)
                }
            }
            return parts.joinToString("/")
        }
    }
}
