package app.shelfmark.reader.reader

import android.app.Activity
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.RenderEffect
import android.os.Build
import android.view.View
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.pow

/**
 * What the reader does to the screen itself: how bright it is, how much blue
 * it shows, and whether the system bars are in the way.
 *
 * Brightness is one setting from 1% to 100%. The upper part of that range
 * turns the backlight down to the lowest the phone allows. Below that, the
 * picture itself is darkened, which is how the screen gets dimmer than the
 * phone's own slider goes. The blue is taken out the same way: every colour
 * on screen is redrawn without (some of) its blue.
 */
object Display {
    /** Below this setting the backlight is as low as it goes and the picture is darkened instead. */
    private const val SOFT_BELOW = 0.15f
    /** How much of the picture's light is left at the very lowest setting. */
    private const val SOFTEST = 0.28f

    /** The backlight for a brightness setting: 0 (the phone's lowest) to 1. */
    fun backlight(level: Float): Float {
        if (level <= SOFT_BELOW) return 0f
        return ((level - SOFT_BELOW) / (1f - SOFT_BELOW)).pow(2f).coerceIn(0f, 1f)
    }

    /** How much of the picture's own light is kept for a brightness setting: 1 is all of it. */
    fun softDim(level: Float): Float {
        if (level < 0f || level >= SOFT_BELOW) return 1f
        val t = ((level - 0.01f) / (SOFT_BELOW - 0.01f)).coerceIn(0f, 1f)
        return SOFTEST + (1f - SOFTEST) * t
    }

    /**
     * @param brightness 0.01 to 1, or below 0 to leave the brightness to the phone
     * @param blueCut    how much blue to take out, 0 to 1
     */
    fun apply(activity: Activity, brightness: Float, blueCut: Float, keepAwake: Boolean) {
        val window = activity.window
        val params = window.attributes
        params.screenBrightness = if (brightness < 0f) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else backlight(brightness)
        window.attributes = params
        if (keepAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        tint(activity.findViewById(android.R.id.content), softDim(brightness), blueCut.coerceIn(0f, 1f))
    }

    /** Put the screen back the way the rest of the app has it. */
    fun clear(activity: Activity) {
        val window = activity.window
        val params = window.attributes
        params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = params
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        tint(activity.findViewById(android.R.id.content), 1f, 0f)
    }

    /** Redraw everything in `view` darker and with less blue. With nothing to change, it is drawn as usual. */
    private fun tint(view: View, light: Float, blueCut: Float) {
        val plain = light >= 0.999f && blueCut <= 0.001f
        // Taking out blue alone leaves white looking green, so some green goes with it: what is left is amber.
        val filter = if (plain) null else ColorMatrixColorFilter(ColorMatrix(floatArrayOf(
            light, 0f, 0f, 0f, 0f,
            0f, light * (1f - 0.38f * blueCut), 0f, 0f, 0f,
            0f, 0f, light * (1f - blueCut), 0f, 0f,
            0f, 0f, 0f, 1f, 0f,
        )))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            view.setRenderEffect(filter?.let { RenderEffect.createColorFilterEffect(it) })
        } else if (filter == null) {
            view.setLayerType(View.LAYER_TYPE_NONE, null)
        } else {
            view.setLayerType(View.LAYER_TYPE_HARDWARE, Paint().apply { colorFilter = filter })
        }
    }

    /** Hide the status and navigation bars while reading; a swipe from the edge shows them for a moment. */
    fun immersive(activity: Activity, on: Boolean) {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (on) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
