package app.shelfmark.reader.reader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.shelfmark.reader.data.Book
import app.shelfmark.reader.data.Library
import app.shelfmark.reader.epub.EpubBook
import app.shelfmark.reader.epub.EpubException
import app.shelfmark.reader.ui.Icons
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** The volume keys turn pages while a book is open: the activity hands them here. */
object ReaderKeys {
    /** Called with 1 (volume down: on) or -1 (volume up: back). Returns true when the key was used. */
    var onVolume: ((Int) -> Boolean)? = null
}

/** The colours of the reader's own bars and panels, taken from the page's theme. */
@Composable
fun ReaderColors(theme: ReaderTheme, content: @Composable () -> Unit) {
    val background = Color(theme.background)
    val text = Color(theme.text)
    val accent = Color(theme.link)
    val panel = when (theme.id) {
        "light" -> Color(0xFFFFFFFF)
        "stone" -> Color(0xFFE9E5DD)
        "dark" -> Color(0xFF1D2023)
        else -> Color(0xFF0C0B0A)
    }
    val line = text.copy(alpha = 0.16f)
    val scheme = if (theme.dark) {
        darkColorScheme(
            primary = accent, onPrimary = background, background = background, onBackground = text,
            surface = panel, onSurface = text, surfaceVariant = line, onSurfaceVariant = text.copy(alpha = 0.7f),
            outline = text.copy(alpha = 0.4f), outlineVariant = line, secondaryContainer = accent.copy(alpha = 0.22f), onSecondaryContainer = text,
            surfaceContainerHighest = line, surfaceContainerHigh = line, surfaceContainer = panel,
        )
    } else {
        lightColorScheme(
            primary = accent, onPrimary = Color.White, background = background, onBackground = text,
            surface = panel, onSurface = text, surfaceVariant = line, onSurfaceVariant = text.copy(alpha = 0.7f),
            outline = text.copy(alpha = 0.4f), outlineVariant = line, secondaryContainer = accent.copy(alpha = 0.16f), onSecondaryContainer = text,
            surfaceContainerHighest = line, surfaceContainerHigh = line, surfaceContainer = panel,
        )
    }
    MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, content = content)
}

@Composable
fun ReaderScreen(book: Book, onClose: () -> Unit) {
    val context = LocalContext.current
    val activity = context as Activity
    val scope = rememberCoroutineScope()
    var problem by remember { mutableStateOf<String?>(null) }

    // Opening the epub reads its table of contents: done off the main thread.
    val state by produceState<ReaderState?>(null, book.file.id) {
        val epub = withContext(Dispatchers.IO) {
            try {
                EpubBook(Library.bookFile(book.file.id))
            } catch (e: EpubException) {
                problem = e.message
                null
            }
        }
        value = epub?.let { ReaderState(context.applicationContext, book, it, scope) }
    }

    DisposableEffect(state) {
        val current = state
        onDispose { current?.close() }
    }
    DisposableEffect(Unit) {
        Display.immersive(activity, true)
        onDispose {
            ReaderKeys.onVolume = null
            Display.immersive(activity, false)
            Display.clear(activity)
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, state) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) state?.flush()
            if (event == Lifecycle.Event.ON_RESUME) Display.immersive(activity, true)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    val reader = state
    val settings = reader?.settings ?: remember { ReaderSettings.load(context) }
    val theme = settings.themeColors

    LaunchedEffect(settings.brightness, settings.blueCut, settings.keepAwake) {
        Display.apply(activity, settings.brightness, settings.blueCut, settings.keepAwake)
    }
    DisposableEffect(reader, settings.volumeKeys) {
        ReaderKeys.onVolume = if (reader != null && settings.volumeKeys) { direction ->
            if (reader.panel == Panel.None && !reader.chrome) {
                reader.turn(direction)
                true
            } else {
                false
            }
        } else {
            null
        }
        onDispose { }
    }

    BackHandler {
        when {
            reader == null -> onClose()
            reader.panel != Panel.None -> reader.showPanel(Panel.None)
            reader.chrome -> reader.showChrome(false)
            else -> onClose()
        }
    }

    // Room for the camera cut-out above the text, and for the line that says where you are below it.
    val density = LocalDensity.current
    val cutout = with(density) { WindowInsets.displayCutout.getTop(this).toDp() }
    val top = (maxOf(cutout.value, 10f) + 12f).roundToInt()
    val bottom = if (settings.footer) 46 else 24

    ReaderColors(theme) {
        Box(Modifier.fillMaxSize().background(Color(theme.background))) {
            if (reader == null) {
                if (problem != null) {
                    Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("This book could not be opened", fontWeight = FontWeight.SemiBold, fontSize = 18.sp, color = Color(theme.text))
                        Spacer(Modifier.height(8.dp))
                        Text(problem ?: "", color = Color(theme.text).copy(alpha = 0.7f))
                        Spacer(Modifier.height(20.dp))
                        Button(onClick = onClose) { Text("Back to the library") }
                    }
                } else {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                return@Box
            }

            // Told before the page is made, so the first layout already has the right room.
            remember(reader, top, bottom) { reader.setInsets(top, bottom) }
            AndroidView(factory = { reader.createView(it) }, modifier = Modifier.fillMaxSize())

            if (settings.footer) {
                val faint = Color(theme.text).copy(alpha = 0.5f)
                Row(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = settings.margin.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(reader.chapterTitle, color = faint, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(12.dp))
                    Text(
                        if (reader.loading) "" else "${reader.page + 1} of ${reader.pages}  ·  ${percent(reader.fraction)}",
                        color = faint, fontSize = 11.sp, maxLines = 1,
                    )
                }
            }

            Chrome(reader, book, cutout.value, onClose)
            NoticeStrip(reader, onOpenLink = { url ->
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            })

            // A panel is put away by touching the page above it.
            if (reader.panel != Panel.None) {
                Box(
                    Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.28f))
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { reader.showPanel(Panel.None) },
                )
            }
            AnimatedVisibility(
                visible = reader.panel == Panel.Settings,
                enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut(),
                modifier = Modifier.align(Alignment.BottomCenter),
            ) { SettingsPanel(reader) }
            AnimatedVisibility(
                visible = reader.panel == Panel.Contents,
                enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut(),
                modifier = Modifier.align(Alignment.BottomCenter),
            ) { ContentsPanel(reader, book, top = cutout.value) }
        }
    }
}

fun percent(fraction: Double): String = "${(fraction * 100).roundToInt().coerceIn(0, 100)}%"

/** The bars that come up when the middle of the page is touched. */
@Composable
private fun Chrome(reader: ReaderState, book: Book, cutout: Float, onClose: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = reader.chrome && reader.panel == Panel.None,
            enter = slideInVertically { -it } + fadeIn(), exit = slideOutVertically { -it } + fadeOut(),
            modifier = Modifier.align(Alignment.TopCenter),
        ) {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 6.dp, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(top = cutout.dp).padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onClose) { Icon(Icons.Back, contentDescription = "Back to the library") }
                    Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                        Text(book.title, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (book.author.isNotEmpty()) {
                            Text(book.author, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    IconButton(onClick = { reader.showPanel(Panel.Contents) }) { Icon(Icons.Contents, contentDescription = "Contents") }
                    TextButton(onClick = { reader.showPanel(Panel.Settings) }) { Text("Aa", fontSize = 19.sp, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
        AnimatedVisibility(
            visible = reader.chrome && reader.panel == Panel.None,
            enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 6.dp, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(start = 18.dp, end = 18.dp, top = 10.dp, bottom = 18.dp)) {
                    // While the slider is held it shows where it would go; the page follows when it is let go.
                    var held by remember { mutableStateOf<Float?>(null) }
                    val shown = held?.toDouble() ?: reader.fraction
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val (index, _) = reader.epub.locate(shown)
                        Text(
                            reader.epub.chapterTitle(if (held == null) reader.spine else index).ifEmpty { book.title },
                            fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        )
                        Text(percent(shown), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Slider(
                        value = shown.toFloat().coerceIn(0f, 1f),
                        onValueChange = { held = it },
                        onValueChangeFinished = {
                            held?.let { reader.seek(it.toDouble()) }
                            held = null
                        },
                    )
                    if (reader.returnTo != null) {
                        TextButton(onClick = { reader.goBack() }) { Text("Back to where you were") }
                    }
                }
            }
        }
    }
}

/** A short note or question at the bottom of the page. */
@Composable
private fun NoticeStrip(reader: ReaderState, onOpenLink: (String) -> Unit) {
    val notice = reader.notice
    // A plain note goes away by itself.
    LaunchedEffect(notice) {
        if (notice is Notice.Text) {
            delay(3200)
            if (reader.notice == notice) reader.notice = null
        }
    }
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = notice != null && reader.panel == Panel.None,
            enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter).padding(start = 14.dp, end = 14.dp, bottom = if (reader.chrome) 140.dp else 52.dp),
        ) {
            Surface(
                color = MaterialTheme.colorScheme.surface, shadowElevation = 8.dp, shape = MaterialTheme.shapes.medium,
                border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Row(Modifier.padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    when (notice) {
                        is Notice.Elsewhere -> {
                            val where = notice.progress.device.ifEmpty { "another device" }
                            Text("Read to ${percent(notice.progress.fraction)} on $where.", fontSize = 14.sp, modifier = Modifier.weight(1f))
                            TextButton(onClick = { reader.follow(notice.progress) }) { Text("Go there") }
                            TextButton(onClick = { reader.notice = null }) { Text("Stay") }
                        }
                        is Notice.Link -> {
                            Text("Open this link in the browser?", fontSize = 14.sp, modifier = Modifier.weight(1f))
                            TextButton(onClick = {
                                onOpenLink(notice.url)
                                reader.notice = null
                            }) { Text("Open") }
                            TextButton(onClick = { reader.notice = null }) { Text("No") }
                        }
                        is Notice.Text -> Text(notice.text, fontSize = 14.sp, modifier = Modifier.padding(vertical = 10.dp).padding(end = 10.dp))
                        null -> Spacer(Modifier.height(1.dp))
                    }
                }
            }
        }
    }
}
