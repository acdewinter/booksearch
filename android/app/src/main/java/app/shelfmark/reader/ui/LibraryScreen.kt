package app.shelfmark.reader.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.shelfmark.reader.data.Book
import app.shelfmark.reader.data.Library
import app.shelfmark.reader.reader.percent
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val covers = LruCache<String, ImageBitmap>(60)

/** A cover as a picture small enough for the grid. Null when the file is not a picture after all. */
private fun decodeCover(file: File): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= 360) sample *= 2
    return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}

private fun parseColor(hex: String): Color? = try {
    if (hex.startsWith("#")) Color(android.graphics.Color.parseColor(hex)) else null
} catch (e: Exception) {
    null
}

@Composable
private fun Cover(book: Book, modifier: Modifier = Modifier) {
    val key = "${book.id}-${book.cover}"
    val image by produceState(covers.get(key), key) {
        if (value == null && book.cover.isNotEmpty()) {
            value = withContext(Dispatchers.IO) { Library.cover(book)?.let { decodeCover(it) } }?.also { covers.put(key, it) }
        }
    }
    Box(
        modifier.aspectRatio(2f / 3f).clip(RoundedCornerShape(topStart = 3.dp, bottomStart = 3.dp, topEnd = 6.dp, bottomEnd = 6.dp))
            .background(parseColor(book.color) ?: Spruce),
    ) {
        val shown = image
        if (shown != null) {
            Image(shown, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Text(
                book.title, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, lineHeight = 16.sp,
                maxLines = 5, overflow = TextOverflow.Ellipsis, modifier = Modifier.align(Alignment.BottomStart).padding(9.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BookCell(book: Book, onOpen: (Book) -> Unit) {
    val kept = Library.isKept(book)
    val downloading = Library.downloading[book.file.id]
    val progress = Library.progress[book.file.id]
    var menu by remember { mutableStateOf(false) }

    Column(
        Modifier.clip(RoundedCornerShape(6.dp)).combinedClickable(
            onClick = {
                when {
                    downloading != null -> {}
                    kept -> onOpen(book)
                    else -> Library.download(book) { ok -> if (ok) onOpen(book) }
                }
            },
            onLongClick = { menu = true },
        ),
    ) {
        Box {
            Cover(book, Modifier.fillMaxWidth())
            // Not on the phone yet: say so on the cover.
            if (!kept) {
                Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = if (downloading != null) 0.5f else 0.28f)))
                Box(
                    Modifier.align(Alignment.Center).size(46.dp).background(Color.Black.copy(alpha = 0.55f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    if (downloading == null) {
                        Icon(Icons.Download, contentDescription = "Not on this phone yet", tint = Color.White)
                    } else if (downloading.fraction < 0f) {
                        CircularProgressIndicator(Modifier.size(30.dp), color = Color.White, strokeWidth = 3.dp)
                    } else {
                        CircularProgressIndicator(progress = { downloading.fraction }, modifier = Modifier.size(30.dp), color = Color.White, trackColor = Color.White.copy(alpha = 0.25f), strokeWidth = 3.dp)
                    }
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                when {
                    downloading != null -> DropdownMenuItem(text = { Text("Stop the download") }, onClick = {
                        menu = false
                        Library.cancelDownload(book)
                    })
                    kept -> DropdownMenuItem(text = { Text("Remove from this phone") }, onClick = {
                        menu = false
                        Library.removeFromPhone(book)
                    })
                    else -> DropdownMenuItem(text = { Text("Download") }, onClick = {
                        menu = false
                        Library.download(book)
                    })
                }
            }
        }
        if (progress != null && progress.fraction > 0.0) {
            LinearProgressIndicator(
                progress = { progress.fraction.toFloat() },
                modifier = Modifier.fillMaxWidth().padding(top = 5.dp).height(3.dp).clip(RoundedCornerShape(2.dp)),
                trackColor = MaterialTheme.colorScheme.outlineVariant, gapSize = 0.dp, drawStopIndicator = {},
            )
        } else {
            Spacer(Modifier.height(8.dp))
        }
        Text(book.title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 5.dp))
        if (book.author.isNotEmpty()) {
            Text(book.author, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val status = when {
            downloading != null -> "Downloading"
            progress == null || progress.fraction <= 0.0 -> if (book.series.isNotEmpty()) book.series else ""
            progress.finished -> "Finished"
            else -> percent(progress.fraction)
        }
        Text(status, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(bottom = 4.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(onOpen: (Book) -> Unit) {
    val scope = rememberCoroutineScope()
    var onlyKept by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { Library.refresh() }

    // What is being read comes first, most recent on top; then the rest, newest first.
    val books = Library.books
        .filter { !onlyKept || Library.isKept(it) }
        .sortedWith(
            compareByDescending<Book> { book -> Library.progress[book.file.id]?.takeIf { !it.finished && it.fraction > 0 }?.updatedAt ?: 0L }
                .thenByDescending { it.addedAt },
        )

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Wordmark(20) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                actions = {
                    if (Library.refreshing) {
                        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
                    } else {
                        IconButton(onClick = { scope.launch { Library.refresh() } }) { Icon(Icons.Refresh, contentDescription = "Fetch the collection again") }
                    }
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.More, contentDescription = "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Disconnect from Shelfmark") }, onClick = {
                                menu = false
                                leaving = true
                            })
                        }
                    }
                },
            )
        },
    ) { padding ->
        LazyVerticalGrid(
            columns = GridCells.Adaptive(104.dp),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + 24.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column {
                    if (Library.lastError.isNotEmpty()) {
                        Text(
                            Library.lastError, color = MaterialTheme.colorScheme.onErrorContainer, fontSize = 14.sp,
                            modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp).background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(6.dp)).padding(12.dp),
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        FilterChip(selected = !onlyKept, onClick = { onlyKept = false }, label = { Text("All books") })
                        FilterChip(selected = onlyKept, onClick = { onlyKept = true }, label = { Text("On this phone") })
                    }
                }
            }
            if (books.isEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Column(Modifier.padding(top = 40.dp, start = 8.dp, end = 8.dp)) {
                        Text(
                            when {
                                Library.refreshing -> "Fetching your collection"
                                onlyKept -> "No books on this phone yet"
                                else -> "Nothing to read yet"
                            },
                            fontSize = 22.sp, fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            when {
                                Library.refreshing -> "One moment."
                                onlyKept -> "Touch a book under All books to bring it onto this phone."
                                else -> "Books show up here once they are in your Shelfmark collection with an epub file. Add one there, then press the round arrow above."
                            },
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            items(books, key = { it.id }) { book -> BookCell(book, onOpen) }
        }
    }

    if (leaving) {
        AlertDialog(
            onDismissRequest = { leaving = false },
            title = { Text("Disconnect from Shelfmark?") },
            text = { Text("The books kept on this phone are removed from it. What you have read stays in Shelfmark, and the books stay in your collection there.") },
            confirmButton = { TextButton(onClick = {
                leaving = false
                Library.unpair()
            }) { Text("Disconnect") } },
            dismissButton = { TextButton(onClick = { leaving = false }) { Text("Cancel") } },
        )
    }
}
