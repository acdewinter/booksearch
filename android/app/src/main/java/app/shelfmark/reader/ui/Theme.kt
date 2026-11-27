package app.shelfmark.reader.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The colours of Shelfmark's own pages: spruce green on paper, with the yellow of a marker pen.
val Spruce = Color(0xFF1D5B4D)
val Marker = Color(0xFFFFDD55)
val Ink = Color(0xFF16211E)

private val Light = lightColorScheme(
    primary = Spruce, onPrimary = Color(0xFFFAFBF8),
    primaryContainer = Color(0xFFDFEAE5), onPrimaryContainer = Color(0xFF144438),
    secondary = Color(0xFF56645F), onSecondary = Color.White,
    secondaryContainer = Color(0xFFDFEAE5), onSecondaryContainer = Color(0xFF144438),
    tertiary = Color(0xFF6F4E00), tertiaryContainer = Marker, onTertiaryContainer = Ink,
    background = Color(0xFFEDF0EC), onBackground = Ink,
    surface = Color(0xFFEDF0EC), onSurface = Ink,
    surfaceVariant = Color(0xFFE3E8E3), onSurfaceVariant = Color(0xFF56645F),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFFAFBF8), surfaceContainer = Color(0xFFFAFBF8),
    surfaceContainerHigh = Color(0xFFF2F4F0), surfaceContainerHighest = Color(0xFFE3E8E3),
    outline = Color(0xFF7D8A85), outlineVariant = Color(0xFFD2D9D3),
    error = Color(0xFFA3322B), errorContainer = Color(0xFFF8E6E3), onErrorContainer = Color(0xFFA3322B),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF7CCDB3), onPrimary = Color(0xFF0F1614),
    primaryContainer = Color(0xFF1C2F29), onPrimaryContainer = Color(0xFFA3E0CB),
    secondary = Color(0xFF9AA8A2), onSecondary = Color(0xFF0F1614),
    secondaryContainer = Color(0xFF1C2F29), onSecondaryContainer = Color(0xFFA3E0CB),
    tertiary = Color(0xFFE6C36C), tertiaryContainer = Marker, onTertiaryContainer = Ink,
    background = Color(0xFF0F1614), onBackground = Color(0xFFE3EAE5),
    surface = Color(0xFF0F1614), onSurface = Color(0xFFE3EAE5),
    surfaceVariant = Color(0xFF212B28), onSurfaceVariant = Color(0xFF9AA8A2),
    surfaceContainerLowest = Color(0xFF0B100F), surfaceContainerLow = Color(0xFF17201D), surfaceContainer = Color(0xFF17201D),
    surfaceContainerHigh = Color(0xFF1D2824), surfaceContainerHighest = Color(0xFF26322E),
    outline = Color(0xFF73827C), outlineVariant = Color(0xFF2B3733),
    error = Color(0xFFF0958C), errorContainer = Color(0xFF3A1F1C), onErrorContainer = Color(0xFFF0958C),
)

@Composable
fun ShelfmarkTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
