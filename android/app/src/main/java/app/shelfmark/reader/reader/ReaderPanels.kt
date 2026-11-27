package app.shelfmark.reader.reader

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.shelfmark.reader.data.Book
import app.shelfmark.reader.ui.Icons
import kotlin.math.roundToInt

private val PANEL_SHAPE = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)

/** A panel that slides up from the bottom. Touches on it do not reach the page behind. */
@Composable
private fun PanelSurface(maxHeight: Float, content: @Composable () -> Unit) {
    val screen = LocalConfiguration.current.screenHeightDp
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = PANEL_SHAPE,
        shadowElevation = 12.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = (screen * maxHeight).dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { },
        content = content,
    )
}

@Composable
private fun Label(text: String, value: String = "") {
    Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        if (value.isNotEmpty()) Text(value, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A value changed in steps, with a button on either side. */
@Composable
private fun Stepper(label: String, value: String, onLess: (() -> Unit)?, onMore: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 15.sp, modifier = Modifier.weight(1f))
        StepButton(Icons.Minus, "Less", onLess)
        Text(value, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.width(92.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        StepButton(Icons.Plus, "More", onMore)
    }
}

@Composable
private fun StepButton(icon: ImageVector, description: String, onClick: (() -> Unit)?) {
    IconButton(
        onClick = { onClick?.invoke() }, enabled = onClick != null,
        modifier = Modifier.size(44.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape),
    ) { Icon(icon, contentDescription = description) }
}

@Composable
private fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun Choices(options: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((id, label) in options) {
            FilterChip(selected = id == selected, onClick = { onPick(id) }, label = { Text(label) })
        }
    }
}

private val LINE_HEIGHTS = listOf(0f, 1.0f, 1.1f, 1.2f, 1.3f, 1.4f, 1.5f, 1.6f, 1.7f, 1.8f, 2.0f, 2.2f)

@Composable
fun SettingsPanel(reader: ReaderState) {
    val s = reader.settings
    PanelSurface(maxHeight = 0.66f) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 26.dp)) {
            // -------------------------------------------------- the screen
            val system = s.brightness < 0f
            Label("Brightness", if (system) "As the phone has it" else "${(s.brightness * 100).roundToInt().coerceAtLeast(1)}%")
            Row(verticalAlignment = Alignment.CenterVertically) {
                Slider(
                    value = if (system) 0.5f else s.brightness,
                    onValueChange = { v -> reader.update { it.copy(brightness = v.coerceIn(0.01f, 1f)) } },
                    valueRange = 0.01f..1f,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(10.dp))
                FilterChip(selected = system, onClick = { reader.update { it.copy(brightness = if (system) 0.5f else -1f) } }, label = { Text("Phone's") })
            }

            Label("Theme")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (theme in THEMES) {
                    val picked = theme.id == s.theme
                    Column(
                        Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable { reader.update { it.copy(theme = theme.id) } },
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            Modifier.fillMaxWidth().height(46.dp)
                                .background(Color(theme.background), RoundedCornerShape(10.dp))
                                .border(if (picked) 2.5.dp else 1.dp, if (picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, RoundedCornerShape(10.dp)),
                            contentAlignment = Alignment.Center,
                        ) { Text("Aa", color = Color(theme.text), fontSize = 17.sp, fontWeight = FontWeight.Medium) }
                        Text(theme.label, fontSize = 12.5.sp, fontWeight = if (picked) FontWeight.SemiBold else FontWeight.Normal, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }

            val night = s.themeColors.noBlue
            Label("Blue light", if (night) "Night takes all of it out" else if (s.warmth <= 0.005f) "As it is" else "${(s.warmth * 100).roundToInt()}% taken out")
            Slider(
                value = if (night) 1f else s.warmth,
                onValueChange = { v -> reader.update { it.copy(warmth = if (v < 0.03f) 0f else v) } },
                enabled = !night,
            )

            HorizontalDivider(Modifier.padding(top = 10.dp), color = MaterialTheme.colorScheme.outlineVariant)

            // ---------------------------------------------------- the text
            Label("Typeface")
            Choices(FONTS.map { it.id to it.label }, s.font) { id -> reader.update { it.copy(font = id) } }

            Spacer(Modifier.height(8.dp))
            Stepper(
                "Text size", "${(s.fontScale * 100).roundToInt()}%",
                onLess = if (s.fontScale > 0.61f) ({ reader.update { it.copy(fontScale = ((it.fontScale - 0.05f) * 20).roundToInt() / 20f) } }) else null,
                onMore = if (s.fontScale < 2.99f) ({ reader.update { it.copy(fontScale = ((it.fontScale + 0.05f) * 20).roundToInt() / 20f) } }) else null,
            )
            val lineAt = LINE_HEIGHTS.indexOfFirst { kotlin.math.abs(it - s.lineHeight) < 0.01f }.coerceAtLeast(0)
            Stepper(
                "Line spacing", if (s.lineHeight <= 0f) "Book's own" else String.format("%.1f", s.lineHeight),
                onLess = if (lineAt > 0) ({ reader.update { it.copy(lineHeight = LINE_HEIGHTS[lineAt - 1]) } }) else null,
                onMore = if (lineAt < LINE_HEIGHTS.size - 1) ({ reader.update { it.copy(lineHeight = LINE_HEIGHTS[lineAt + 1]) } }) else null,
            )
            Stepper(
                "Margins", when {
                    s.margin <= 10 -> "Narrow"
                    s.margin <= 26 -> "Medium"
                    s.margin <= 40 -> "Wide"
                    else -> "Widest"
                } + " · ${s.margin}",
                onLess = if (s.margin > 6) ({ reader.update { it.copy(margin = it.margin - 4) } }) else null,
                onMore = if (s.margin < 54) ({ reader.update { it.copy(margin = it.margin + 4) } }) else null,
            )

            Label("Alignment")
            Choices(listOf("book" to "Book's own", "justify" to "Justified", "left" to "Left"), s.align) { id -> reader.update { it.copy(align = id) } }
            Spacer(Modifier.height(6.dp))
            Toggle("Space between paragraphs", s.spaced) { on -> reader.update { it.copy(spaced = on) } }

            HorizontalDivider(Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)

            // ------------------------------------------------ turning pages
            Label("Touching the sides of the page")
            Choices(listOf("sides" to "Left goes back", "forward" to "Both go on", "off" to "Does nothing"), s.taps) { id -> reader.update { it.copy(taps = id) } }
            Spacer(Modifier.height(6.dp))
            Toggle("Slide when a page turns", s.slide) { on -> reader.update { it.copy(slide = on) } }
            Toggle("Volume keys turn pages", s.volumeKeys) { on -> reader.update { it.copy(volumeKeys = on) } }
            Toggle("Keep the screen on", s.keepAwake) { on -> reader.update { it.copy(keepAwake = on) } }
            Toggle("Show where you are at the bottom", s.footer) { on -> reader.update { it.copy(footer = on) } }
        }
    }
}

@Composable
fun ContentsPanel(reader: ReaderState, book: Book, top: Float) {
    val entries = reader.epub.toc
    val current = reader.epub.currentTocIndex(reader.spine)
    val listState = rememberLazyListState()
    LaunchedEffect(Unit) {
        if (current > 3) listState.scrollToItem(current - 3)
    }
    PanelSurface(maxHeight = 0.86f) {
        Column {
            Row(Modifier.padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Contents", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                    Text(book.title, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { reader.showPanel(Panel.None) }) { Icon(Icons.Close, contentDescription = "Close") }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            if (entries.isEmpty()) {
                Text(
                    "This book has no table of contents. Use the slider to move through it.",
                    modifier = Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
                    itemsIndexed(entries) { i, entry ->
                        val here = i == current
                        Row(
                            Modifier.fillMaxWidth()
                                .background(if (here) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                                .clickable { reader.open(entry) }
                                .padding(start = (20 + entry.depth.coerceAtMost(4) * 16).dp, end = 20.dp, top = 13.dp, bottom = 13.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                entry.title, fontSize = if (entry.depth == 0) 15.5.sp else 14.5.sp,
                                fontWeight = if (here) FontWeight.SemiBold else FontWeight.Normal,
                                color = if (here) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                            )
                            val at = reader.epub.indexOf(entry.path)
                            if (at >= 0) {
                                Text(percent(reader.epub.fractionAt(at, 0.0)), fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp))
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}
