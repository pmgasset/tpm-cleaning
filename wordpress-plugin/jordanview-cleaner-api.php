<?php
/**
 * Plugin Name: Jordan View Cleaner Portal API
 * Description: Exposes upcoming reservations from the TPM v2 / GMS plugin
 *              for the cleaning.240jordanview.com portal.
 * Version:     2.0.0
 */

defined('ABSPATH') || exit;

// ─── REST routes ──────────────────────────────────────────────────────────────
add_action('rest_api_init', function () {
    register_rest_route('cleanerportal/v1', '/reservations', [
        'methods'             => 'GET',
        'callback'            => 'jv_get_reservations',
        'permission_callback' => 'jv_check_api_key',
    ]);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Add to wp-config.php:  define('JV_CLEANER_API_KEY', 'your-secret-here');
function jv_check_api_key(WP_REST_Request $request): bool {
    $expected = defined('JV_CLEANER_API_KEY') ? JV_CLEANER_API_KEY : '';
    $provided  = $request->get_header('X-Cleaner-API-Key');
    return $expected !== '' && hash_equals($expected, (string) $provided);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
function jv_get_reservations(): WP_REST_Response {
    return new WP_REST_Response(['reservations' => jv_fetch_reservations()], 200);
}

// ─── TPM v2 / GMS adapter ────────────────────────────────────────────────────
// Reads directly from the wp_gms_reservations table used by the
// Guest Management System (tpm-v2) plugin.
function jv_fetch_reservations(): array {
    global $wpdb;

    $table = $wpdb->prefix . 'gms_reservations';
    $now   = current_time('mysql');

    // Fetch upcoming non-cancelled reservations ordered by checkout date
    // (cleaners care about when guests leave, not when they arrive)
    $rows = $wpdb->get_results(
        $wpdb->prepare(
            "SELECT id, booking_reference, guest_name, property_id, property_name,
                    checkin_date, checkout_date, status, webhook_payload, housekeeper_token
               FROM {$table}
              WHERE checkout_date > %s
                AND status NOT IN ('cancelled')
                AND checkin_date <> '0000-00-00 00:00:00'
              ORDER BY checkout_date ASC
              LIMIT 20",
            $now
        ),
        ARRAY_A
    );

    if (!$rows) return [];

    return array_map(function ($row) {
        // Guest count and pet data live inside the webhook_payload JSON blob
        $payload     = [];
        $guests_count = 0;
        $pets         = 0;
        $notes        = '';

        if (!empty($row['webhook_payload'])) {
            $payload = json_decode($row['webhook_payload'], true) ?: [];

            // guests_count is mapped from 'guests_count','number_of_guests','adults','pax'
            foreach (['guests_count', 'number_of_guests', 'adults', 'pax'] as $key) {
                if (!empty($payload[$key])) {
                    $guests_count = intval($payload[$key]);
                    break;
                }
            }

            // Pets — commonly stored as pets, pet, allows_pets, has_pets
            foreach (['pets', 'pet', 'pets_count', 'number_of_pets'] as $key) {
                if (!empty($payload[$key])) {
                    $pets = intval($payload[$key]);
                    break;
                }
            }

            // Owner-facing notes for the cleaner
            foreach (['internal_notes', 'housekeeper_notes', 'cleaner_notes', 'notes'] as $key) {
                if (!empty($payload[$key])) {
                    $notes = sanitize_text_field($payload[$key]);
                    break;
                }
            }
        }

        // Parse datetimes — stored as MySQL datetime strings
        $co = !empty($row['checkout_date']) ? new DateTime($row['checkout_date']) : null;
        $ci = !empty($row['checkin_date'])  ? new DateTime($row['checkin_date'])  : null;

        return [
            'id'            => $row['id'],
            'booking_ref'   => $row['booking_reference'],
            'label'         => trim($co ? $co->format('M j') . ($ci ? '–' . $ci->format('M j') : '') . ' · ' . ($row['property_name'] ?: 'Jordan View') : ''),
            'property_id'   => $row['property_id'],
            'property_name' => $row['property_name'] ?: '240 Jordan View',
            'checkout_date' => $co ? $co->format('Y-m-d') : null,
            'checkout_time' => $co ? $co->format('g:i a') : '11:00 am',
            'checkin_date'  => $ci ? $ci->format('Y-m-d') : null,
            'checkin_time'  => $ci ? $ci->format('g:i a') : '4:00 pm',
            'guests'        => $guests_count,
            'pets'          => $pets,
            'notes'         => $notes,
            'status'        => $row['status'],
            'tentative'     => in_array($row['status'], ['pending', 'awaiting_signature', 'awaiting_id_verification']),
        ];
    }, $rows);
}
