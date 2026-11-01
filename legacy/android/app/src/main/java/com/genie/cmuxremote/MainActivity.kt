package com.genie.cmuxremote

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.genie.cmuxremote.state.AppViewModel
import com.genie.cmuxremote.state.ConnectionState
import com.genie.cmuxremote.state.InboxItem
import com.genie.cmuxremote.ui.CmuxCanvas
import com.genie.cmuxremote.ui.CmuxTheme
import com.genie.cmuxremote.ui.ConnectScreen
import com.genie.cmuxremote.ui.MainShell

class MainActivity : ComponentActivity() {

    private val vm: AppViewModel by viewModels()
    private var nextNotificationId = 1

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        createNotificationChannel()
        maybeAskNotificationPermission()
        vm.onNotification = { postNotification(it) }
        handlePairIntent(intent)
        // iOS reconnects on launch whenever an endpoint is configured.
        if (vm.hasEndpointConfig && vm.connectionState == ConnectionState.DISCONNECTED) {
            vm.connect()
        }

        setContent {
            CmuxTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = CmuxCanvas) {
                    val configured = vm.hasEndpointConfig
                    val linked = vm.connectionState == ConnectionState.CONNECTED ||
                        vm.connectionState == ConnectionState.CONNECTING
                    if (configured || linked) {
                        MainShell(vm)
                    } else {
                        ConnectScreen(vm)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairIntent(intent)
    }

    private fun handlePairIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "cmux" && data.host == "pair") {
            if (vm.applyPairingLink(data.toString())) {
                vm.connect()
            }
        }
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            "cmux_events",
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun maybeAskNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun postNotification(item: InboxItem) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return
        val notification = NotificationCompat.Builder(this, "cmux_events")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(item.title)
            .setContentText(item.body.take(200))
            .setAutoCancel(true)
            .build()
        runCatching {
            NotificationManagerCompat.from(this).notify(nextNotificationId++, notification)
        }
    }
}
