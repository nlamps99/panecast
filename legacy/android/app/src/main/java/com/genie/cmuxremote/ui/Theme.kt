package com.genie.cmuxremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ---------------------------------------------------------------------
// Tokyo Night Storm palette — mirrors iOS CmuxTheme (.storm)
// ---------------------------------------------------------------------

val CmuxCanvas = Color(0xFF1A1B26)
val CmuxSurface = Color(0xFF24283B)
val CmuxSurfaceRaised = Color(0xFF292E42)
val CmuxSurfaceSunken = Color(0xFF1F2335)
val CmuxTerminal = Color(0xFF16161E)
val CmuxInk = Color(0xFFC0CAF5)
val CmuxInkDim = Color(0xFFA9B1D6)
val CmuxMuted = Color(0xFF565F89)
val CmuxMutedDim = Color(0xFF414868)
val CmuxDivider = Color(0xFF3B4261)
val CmuxBorder = Color(0xFF545C7E)
val CmuxAccentBlue = Color(0xFF7AA2F7)
val CmuxAccentCyan = Color(0xFF7DCFFF)
val CmuxAccentTeal = Color(0xFF1ABC9C)
val CmuxAccentGreen = Color(0xFF9ECE6A)
val CmuxAccentYellow = Color(0xFFE0AF68)
val CmuxAccentOrange = Color(0xFFFF9E64)
val CmuxAccentRed = Color(0xFFF7768E)
val CmuxAccentMagenta = Color(0xFFBB9AF7)
val CmuxTerminalText = Color(0xFFF1F2F8)

// Back-compat aliases used by older Android screens.
val CmuxBackground = CmuxCanvas
val CmuxSurfaceVariant = CmuxSurfaceRaised
val CmuxAccent = CmuxAccentGreen
val CmuxOnAccent = CmuxCanvas
val CmuxText = CmuxInk
val CmuxTextDim = CmuxMuted
val CmuxDanger = CmuxAccentRed
val CmuxWarning = CmuxAccentYellow

private val scheme = darkColorScheme(
    primary = CmuxAccentBlue,
    onPrimary = CmuxCanvas,
    secondary = CmuxInkDim,
    background = CmuxCanvas,
    onBackground = CmuxInk,
    surface = CmuxSurface,
    onSurface = CmuxInk,
    surfaceVariant = CmuxSurfaceRaised,
    onSurfaceVariant = CmuxInkDim,
    error = CmuxAccentRed,
    outline = CmuxDivider,
)

@Composable
fun CmuxTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}

// ---------------------------------------------------------------------
// Text styles — display ≈ pixel labels (monospace + tracking + caps),
// body ≈ Geist Mono (plain monospace).
// ---------------------------------------------------------------------

fun cmuxDisplay(size: Float): TextStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontWeight = FontWeight.Bold,
    fontSize = size.sp,
    letterSpacing = 0.6.sp,
)

fun cmuxMono(size: Float, weight: FontWeight = FontWeight.Normal): TextStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontWeight = weight,
    fontSize = size.sp,
)

// ---------------------------------------------------------------------
// Surface styling
// ---------------------------------------------------------------------

fun Modifier.cmuxSurface(
    corner: Dp = 10.dp,
    fill: Color = CmuxSurface,
    border: Color = CmuxDivider,
): Modifier = this
    .clip(RoundedCornerShape(corner))
    .background(fill)
    .border(1.dp, border, RoundedCornerShape(corner))

fun Modifier.cmuxHairline(
    color: Color = CmuxDivider,
    corner: Dp = 10.dp,
): Modifier = this.border(1.dp, color, RoundedCornerShape(corner))

// ---------------------------------------------------------------------
// ASCII box-drawing rule: ═══ TITLE ═══  (iOS CmuxRule)
// ---------------------------------------------------------------------

@Composable
fun CmuxRule(title: String? = null, color: Color = CmuxDivider) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        RuleSegment(color, Modifier.weight(1f))
        if (title != null) {
            Text(
                title.uppercase(),
                style = cmuxDisplay(11f),
                color = CmuxMuted,
                modifier = Modifier.padding(horizontal = 8.dp),
                maxLines = 1,
            )
            RuleSegment(color, Modifier.weight(1f))
        }
    }
}

@Composable
private fun RuleSegment(color: Color, modifier: Modifier = Modifier) {
    Text(
        "═".repeat(300),
        style = cmuxDisplay(11f),
        color = color,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Clip,
        modifier = modifier.height(14.dp),
    )
}

// ---------------------------------------------------------------------
// Status color mapping shared by header/subtitle rows
// ---------------------------------------------------------------------

@Composable
fun connectionColor(state: com.genie.cmuxremote.state.ConnectionState): Color = when (state) {
    com.genie.cmuxremote.state.ConnectionState.CONNECTED -> CmuxAccentGreen
    com.genie.cmuxremote.state.ConnectionState.CONNECTING -> CmuxAccentYellow
    com.genie.cmuxremote.state.ConnectionState.DISCONNECTED -> CmuxMuted
    com.genie.cmuxremote.state.ConnectionState.ERROR -> CmuxAccentRed
}

fun connectionSubtitle(state: com.genie.cmuxremote.state.ConnectionState): String = when (state) {
    com.genie.cmuxremote.state.ConnectionState.CONNECTED -> "relay connected"
    com.genie.cmuxremote.state.ConnectionState.CONNECTING -> "connecting…"
    com.genie.cmuxremote.state.ConnectionState.DISCONNECTED -> "offline"
    com.genie.cmuxremote.state.ConnectionState.ERROR -> "needs attention"
}
