package com.genie.cmuxremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.genie.cmuxremote.state.AppViewModel
import com.genie.cmuxremote.state.InboxItem

/**
 * Android port of iOS `NotificationCenterView`.
 */
@Composable
fun InboxScreen(vm: AppViewModel, onOpenItem: (InboxItem) -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("inbox", style = cmuxDisplay(28f), color = CmuxInk)
                Spacer(Modifier.width(8.dp))
                Text("[${vm.inbox.size}]", style = cmuxDisplay(14f), color = CmuxMuted)
                Spacer(Modifier.weight(1f))
                if (vm.unreadInbox > 0) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .heightIn(min = 30.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(CmuxAccentBlue)
                            .clickable { vm.markInboxRead() }
                            .padding(horizontal = 10.dp),
                    ) {
                        Icon(
                            Icons.Filled.CheckCircle,
                            contentDescription = null,
                            tint = CmuxCanvas,
                            modifier = Modifier.size(12.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text("[ MARK ALL READ ]", style = cmuxDisplay(10f), color = CmuxCanvas)
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        item { CmuxRule("events") }

        if (vm.inbox.isEmpty()) {
            item {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .fillMaxWidth()
                        .cmuxSurface(corner = 8.dp, fill = CmuxSurface)
                        .padding(vertical = 40.dp),
                ) {
                    Text("[ no events ]", style = cmuxDisplay(13f), color = CmuxMuted)
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "cmux relay events will appear here",
                        style = cmuxMono(11f),
                        color = CmuxMuted,
                    )
                }
            }
        } else {
            items(vm.inbox, key = { it.id }) { item ->
                InboxCard(item, onClick = { onOpenItem(item) })
            }
        }
    }
}

@Composable
private fun InboxCard(item: InboxItem, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .cmuxSurface(corner = 8.dp, fill = CmuxSurface)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("›", style = cmuxDisplay(11f), color = CmuxAccentGreen)
            Spacer(Modifier.width(6.dp))
            Text(
                item.title,
                style = cmuxMono(14f, FontWeight.Medium),
                color = CmuxInk,
                maxLines = 1,
            )
        }
        item.subtitle?.let {
            Text(it, style = cmuxDisplay(10f), color = CmuxAccentBlue, maxLines = 1)
        }
        Text(
            item.body,
            style = cmuxMono(12f),
            color = CmuxInkDim,
            maxLines = 4,
        )
    }
}
