package com.example.jsonbridgereceiver

import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream

object JsonFraming {
    private const val MAX_FRAME = 8 * 1024 * 1024

    fun write(out: OutputStream, json: JSONObject) {
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size in 1..MAX_FRAME) { "frame too large: ${bytes.size}" }
        val header = byteArrayOf(
            (bytes.size ushr 24).toByte(),
            (bytes.size ushr 16).toByte(),
            (bytes.size ushr 8).toByte(),
            bytes.size.toByte()
        )
        out.write(header)
        out.write(bytes)
        out.flush()
    }

    fun read(input: InputStream): JSONObject? {
        val header = ByteArray(4)
        if (!readExact(input, header)) return null
        val len = ((header[0].toInt() and 0xFF) shl 24) or
                ((header[1].toInt() and 0xFF) shl 16) or
                ((header[2].toInt() and 0xFF) shl 8) or
                (header[3].toInt() and 0xFF)
        require(len in 1..MAX_FRAME) { "invalid frame length: $len" }
        val body = ByteArray(len)
        if (!readExact(input, body)) return null
        return JSONObject(String(body, Charsets.UTF_8))
    }

    private fun readExact(input: InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n <= 0) return false
            off += n
        }
        return true
    }
}