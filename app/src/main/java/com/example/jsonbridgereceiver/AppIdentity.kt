package com.example.jsonbridgereceiver

import android.content.Context
import java.util.UUID

class AppIdentity private constructor(
    val cid: String,
    val token: String
) {
    companion object {
        private const val PREF = "jsonbridge_identity"
        private const val KEY_CID = "cid"
        private const val KEY_TOKEN = "token"

        @Volatile private var instance: AppIdentity? = null

        fun get(context: Context): AppIdentity {
            instance?.let { return it }
            synchronized(this) {
                instance?.let { return it }
                val sp = context.applicationContext
                    .getSharedPreferences(PREF, Context.MODE_PRIVATE)

                var cid = sp.getString(KEY_CID, null)
                var token = sp.getString(KEY_TOKEN, null)
                if (cid == null || token == null) {
                    cid = UUID.randomUUID().toString()
                    token = UUID.randomUUID().toString()
                    sp.edit().putString(KEY_CID, cid).putString(KEY_TOKEN, token).apply()
                }
                val id = AppIdentity(cid, token)
                instance = id
                return id
            }
        }
    }

    fun reset(context: Context) {
        synchronized(this) {
            instance = null
            context.applicationContext
                .getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().clear().apply()
        }
    }
}