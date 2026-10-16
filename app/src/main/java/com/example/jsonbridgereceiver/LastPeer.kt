package com.example.jsonbridgereceiver

import android.content.Context

/**
 * 记住上一次发现的电脑（host / port / sid / 名称）。
 *
 * 用途：App 或前台服务重启后，**不必等组播发现**就能立刻重连。
 * 手机上组播包很容易被系统丢弃（Wi-Fi 省电、后台限制），
 * 只靠「发现广播」驱动连接会出现「服务明明活着却长时间连不上」。
 */
object LastPeer {
    private const val PREF = "jsonbridge_last_peer"

    data class Peer(val host: String, val port: Int, val sid: String, val name: String)

    fun save(ctx: Context, p: Peer) {
        ctx.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
            .putString("host", p.host)
            .putInt("port", p.port)
            .putString("sid", p.sid)
            .putString("name", p.name)
            .apply()
    }

    fun load(ctx: Context): Peer? {
        val sp = ctx.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val host = sp.getString("host", null) ?: return null
        val sid = sp.getString("sid", null) ?: return null
        val port = sp.getInt("port", 0)
        if (port <= 0) return null
        return Peer(host, port, sid, sp.getString("name", "") ?: "")
    }

    fun clear(ctx: Context) {
        ctx.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
