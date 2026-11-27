package app.shelfmark.reader

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.core.view.WindowCompat
import app.shelfmark.reader.data.Library
import app.shelfmark.reader.reader.ReaderKeys
import app.shelfmark.reader.reader.ReaderScreen
import app.shelfmark.reader.ui.LibraryScreen
import app.shelfmark.reader.ui.PairRequest
import app.shelfmark.reader.ui.SetupScreen
import app.shelfmark.reader.ui.ShelfmarkTheme
import kotlinx.coroutines.launch

/**
 * The whole app is this one activity. It shows one of three things: the
 * screen that pairs the app with a Shelfmark server, the books of the
 * collection, or a book that is being read.
 */
class MainActivity : ComponentActivity() {
    /** A pairing link the app was opened with, until it has been dealt with. */
    private var pairRequest by mutableStateOf<PairRequest?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        Library.init(applicationContext)
        if (savedInstanceState == null) readLink(intent)

        setContent {
            ShelfmarkTheme {
                // Dark icons in the status bar on a light page, light ones on a dark page.
                val dark = isSystemInDarkTheme()
                SideEffect {
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        isAppearanceLightStatusBars = !dark
                        isAppearanceLightNavigationBars = !dark
                    }
                }
                var openId by rememberSaveable { mutableStateOf<String?>(null) }
                var pairing by rememberSaveable { mutableStateOf(false) }
                val request = pairRequest
                val open = Library.books.firstOrNull { it.id == openId }?.takeIf { Library.isKept(it) }
                when {
                    request != null || pairing || !Library.paired -> SetupScreen(
                        request = request,
                        onCancel = if (Library.paired) ({
                            pairRequest = null
                            pairing = false
                        }) else null,
                        onDone = {
                            pairRequest = null
                            pairing = false
                        },
                    )
                    open != null -> ReaderScreen(open, onClose = { openId = null })
                    else -> LibraryScreen(onOpen = { openId = it.id })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        readLink(intent)
    }

    /** shelfmark://pair?server=https://books.example.com&code=ABCD-EFGH */
    private fun readLink(intent: Intent?) {
        val link = intent?.data ?: return
        if (link.scheme != "shelfmark" || link.host != "pair") return
        val server = link.getQueryParameter("server") ?: return
        pairRequest = PairRequest(server, link.getQueryParameter("code") ?: "")
    }

    override fun onStop() {
        super.onStop()
        // Whatever was read is told to the server when the app is put away.
        Library.persist()
        Library.scope.launch { Library.pushProgress() }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val direction = when (event.keyCode) {
            KeyEvent.KEYCODE_VOLUME_DOWN -> 1
            KeyEvent.KEYCODE_VOLUME_UP -> -1
            else -> 0
        }
        val turn = ReaderKeys.onVolume
        if (direction != 0 && turn != null) {
            // The page turns as the key goes down; the key coming back up is swallowed with it.
            if (event.action == KeyEvent.ACTION_DOWN) {
                if (event.repeatCount > 0 || turn(direction)) return true
            } else if (event.action == KeyEvent.ACTION_UP) {
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }
}
