package app.shelfmark.reader

import app.shelfmark.reader.epub.EpubBook
import app.shelfmark.reader.epub.EpubException
import app.shelfmark.reader.reader.BookClient
import app.shelfmark.reader.reader.Display
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.kxml2.io.KXmlParser

/** Opening epubs, tidy and awkward ones. The files are written by dev/make-test-epubs.js. */
class EpubBookTest {
    @Before
    fun parser() {
        // The same XML reader Android has built in.
        EpubBook.newParser = { KXmlParser() }
    }

    private fun fixture(name: String): File {
        val out = File.createTempFile("shelfmark", ".epub")
        out.deleteOnExit()
        javaClass.classLoader!!.getResourceAsStream(name)!!.use { input -> out.outputStream().use { input.copyTo(it) } }
        return out
    }

    @Test
    fun aTidyBookIsReadWithItsContents() {
        EpubBook(fixture("practice.epub")).use { book ->
            assertEquals("The Practice Book", book.title)
            assertEquals("Reader, Practice", book.author)
            assertEquals("en", book.language)
            assertEquals((1..4).map { "OEBPS/text/chapter-$it.xhtml" }, book.spine.map { it.path })
            assertEquals(listOf("Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"), book.toc.map { it.title })
            assertEquals(book.spine.map { it.path }, book.toc.map { it.path })
            assertTrue(book.toc.all { it.depth == 0 && it.fragment.isEmpty() })

            assertEquals("text/css", book.typeOf("OEBPS/style.css"))
            assertEquals("image/png", book.typeOf("OEBPS/images/cover.png"))
            assertTrue(String(book.read("OEBPS/text/chapter-2.xhtml")!!).contains("<h1 id=\"start\">Chapter 2</h1>"))
            assertNull(book.read("OEBPS/nope.xhtml"))
            assertEquals(2, book.indexOf("OEBPS/text/chapter-3.xhtml"))
            assertEquals(-1, book.indexOf("OEBPS/style.css"))
        }
    }

    @Test
    fun progressIsCountedByTheSizeOfTheChapters() {
        EpubBook(fixture("practice.epub")).use { book ->
            assertEquals(0.0, book.fractionAt(0, 0.0), 1e-9)
            assertEquals(1.0, book.fractionAt(3, 1.0), 1e-9)
            val half = book.fractionAt(2, 0.0)
            assertTrue("the four chapters are about the same size", half > 0.45 && half < 0.55)
            assertTrue(book.fractionAt(1, 0.5) < book.fractionAt(1, 0.6))

            // A place in the book leads back to the same chapter and spot.
            for (index in 0..3) for (within in listOf(0.0, 0.25, 0.8)) {
                val (i, w) = book.locate(book.fractionAt(index, within))
                assertEquals(index, i)
                assertEquals(within, w, 0.01)
            }
            assertEquals(0, book.locate(0.0).first)
            assertEquals(3, book.locate(1.0).first)
            assertEquals("Chapter 3", book.chapterTitle(2))
            assertEquals(2, book.currentTocIndex(2))
        }
    }

    @Test
    fun anAwkwardBookIsStillReadable() {
        EpubBook(fixture("awkward.epub")).use { book ->
            assertEquals("An Awkward Book", book.title)
            assertEquals("Ann Author", book.author)
            assertEquals("nl", book.language)
            // A chapter the package names but the zip does not hold is left out; names are found whatever their case.
            assertEquals(listOf("text/cover.xhtml", "Text/Chapter One.xhtml", "Text/café.xhtml", "Text/broken.xhtml"), book.spine.map { it.path })
            assertEquals(1, book.indexOf("Text/Chapter One.xhtml"))
            assertEquals(0, book.indexOf("Text/Cover.xhtml"))

            // The contents: nested, with a link into a chapter; the line that leads nowhere is dropped.
            assertEquals(listOf("Part One", "A Scene in the Middle", "Café & Bar"), book.toc.map { it.title })
            assertEquals(listOf(0, 1, 0), book.toc.map { it.depth })
            assertEquals(listOf("", "middle", ""), book.toc.map { it.fragment })
            assertEquals("Text/café.xhtml", book.toc[2].path)

            assertEquals("", book.chapterTitle(0))
            assertEquals("Part One", book.chapterTitle(1))
            assertEquals("Café & Bar", book.chapterTitle(3))
            assertEquals(-1, book.currentTocIndex(0))
            assertEquals(1, book.currentTocIndex(1))
            assertEquals(2, book.currentTocIndex(3))
            assertEquals("text/css", book.typeOf("Styles/main.css"))
            assertNotNull(book.read("Text/café.xhtml"))
        }
    }

    @Test
    fun whatIsNotAnEpubIsRefused() {
        val text = File.createTempFile("shelfmark", ".epub").apply {
            writeText("just some text")
            deleteOnExit()
        }
        try {
            EpubBook(text)
            fail("a text file is not an epub")
        } catch (e: EpubException) {
            assertTrue(e.message!!.isNotEmpty())
        }
    }

    @Test
    fun pathsInsideTheBookAreWorkedOut() {
        assertEquals("OEBPS/text/one.xhtml", EpubBook.resolve("OEBPS", "text/one.xhtml"))
        assertEquals("OEBPS/images/a b.png", EpubBook.resolve("OEBPS/text", "../images/a%20b.png"))
        assertEquals("one.xhtml", EpubBook.resolve("", "./one.xhtml"))
        assertEquals("a+b.xhtml", EpubBook.resolve("", "a+b.xhtml"))
        assertEquals("top.xhtml", EpubBook.resolve("OEBPS", "../../top.xhtml"))
    }

    @Test
    fun theReaderIsAddedToTheHeadOfAChapter() {
        val added = "<script type=\"text/javascript\" src=\"https://reader.invalid/reader.js\"></script>"
        val plain = BookClient.inject("<html><head><title>x</title></head><body/></html>")
        assertTrue(plain.startsWith("<html><head><meta name=\"viewport\""))
        assertTrue(plain.contains("$added<title>x</title>"))
        assertTrue(BookClient.inject("<HTML><HEAD profile=\"p\">\n</HEAD></HTML>").contains("<HEAD profile=\"p\"><meta"))
        assertTrue(BookClient.inject("<html xmlns=\"x\"><body/></html>").contains("<html xmlns=\"x\"><head><meta"))
        assertTrue(BookClient.inject("<p>bare</p>").endsWith("$added<p>bare</p>"))
        // "<header>" is not the head.
        assertFalse(BookClient.inject("<html><head></head><body><header>h</header></body></html>").contains("<header><meta"))
    }

    @Test
    fun chaptersInOtherEncodingsBecomeUtf8() {
        assertEquals("<p>é</p>", BookClient.decode(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "<p>é</p>".toByteArray()))
        val latin = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?><p>café</p>".toByteArray(Charsets.ISO_8859_1)
        assertEquals("<?xml version=\"1.0\" encoding=\"utf-8\"?><p>café</p>", BookClient.decode(latin))
        val wide = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "<p>ü</p>".toByteArray(Charsets.UTF_16LE)
        assertEquals("<p>ü</p>", BookClient.decode(wide))
        assertEquals("<p>plain</p>", BookClient.decode("<p>plain</p>".toByteArray()))
    }

    @Test
    fun brightnessGoesDownSmoothlyAllTheWay() {
        assertEquals(1f, Display.backlight(1f), 1e-6f)
        assertEquals(0f, Display.backlight(0.15f), 1e-6f)
        assertEquals(0f, Display.backlight(0.01f), 1e-6f)
        assertEquals(1f, Display.softDim(0.5f), 1e-6f)
        assertEquals(1f, Display.softDim(-1f), 1e-6f)
        assertTrue(Display.softDim(0.01f) < 0.3f)
        // Never brighter at a lower setting, across the whole range.
        var lastLight = -1f
        var lastDim = -1f
        for (step in 1..100) {
            val level = step / 100f
            assertTrue(Display.backlight(level) >= lastLight)
            assertTrue(Display.softDim(level) >= lastDim)
            lastLight = Display.backlight(level)
            lastDim = Display.softDim(level)
        }
    }
}
