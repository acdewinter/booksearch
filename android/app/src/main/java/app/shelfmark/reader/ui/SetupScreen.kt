package app.shelfmark.reader.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.shelfmark.reader.data.ApiException
import app.shelfmark.reader.data.Library
import kotlinx.coroutines.launch

/** What a "shelfmark://pair" link carries: where the server is, and the code to pair with. */
data class PairRequest(val server: String, val code: String)

/** The name of the app, the way Shelfmark's own page writes it. */
@Composable
fun Wordmark(size: Int = 22) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.background(Marker, RoundedCornerShape(4.dp)).padding(horizontal = (size / 3).dp)) {
            Text("!", color = Ink, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = size.sp)
        }
        Spacer(Modifier.size(8.dp))
        Text("Shelfmark", fontWeight = FontWeight.Bold, fontSize = size.sp, color = MaterialTheme.colorScheme.onBackground)
    }
}

/**
 * Connect the app to a Shelfmark server.
 *
 * @param request  filled in from a pairing link, and tried straight away
 * @param onCancel shown as a way back when the app is paired already
 * @param onDone   the app is paired
 */
@Composable
fun SetupScreen(request: PairRequest?, onCancel: (() -> Unit)?, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var address by rememberSaveable { mutableStateOf(request?.server ?: Library.server) }
    var code by rememberSaveable { mutableStateOf(request?.code ?: "") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf("") }

    fun connect() {
        if (busy) return
        busy = true
        problem = ""
        scope.launch {
            try {
                Library.pair(address, code)
                onDone()
            } catch (e: ApiException) {
                problem = e.message ?: "That did not work."
            } finally {
                busy = false
            }
        }
    }

    // Opened from "Open in the reader app": everything needed is there already.
    LaunchedEffect(request) {
        if (request != null && request.server.isNotBlank()) {
            address = request.server
            code = request.code
            connect()
        }
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).systemBarsPadding().imePadding()) {
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 460.dp).verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Wordmark(26)
            Text("Reader", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
            Text(
                "Read the epubs in your Shelfmark collection on this phone. Where you are in each book is kept in step with Shelfmark.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            OutlinedTextField(
                value = address, onValueChange = { address = it },
                label = { Text("Address of your Shelfmark") },
                placeholder = { Text("https://books.example.com") },
                singleLine = true, enabled = !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = code, onValueChange = { code = it.uppercase() },
                label = { Text("Pairing code") },
                placeholder = { Text("ABCD-EFGH") },
                supportingText = { Text("In Shelfmark, open Collection and press Reader app. Leave this empty if your Shelfmark has no sign-in.") },
                singleLine = true, enabled = !busy,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onGo = { connect() }),
                modifier = Modifier.fillMaxWidth(),
            )
            if (problem.isNotEmpty()) {
                Text(
                    problem, color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(6.dp)).padding(12.dp),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { connect() }, enabled = !busy && address.isNotBlank()) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        Spacer(Modifier.size(10.dp))
                    }
                    Text(if (busy) "Connecting" else "Connect")
                }
                if (onCancel != null) TextButton(onClick = onCancel, enabled = !busy) { Text("Cancel") }
            }
        }
    }
}
