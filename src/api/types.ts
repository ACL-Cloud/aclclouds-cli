/** Subset of the panel's ServerTransformer attributes used by the CLI. */
export interface Service {
    identifier: string;
    uuid: string;
    name: string;
    description?: string | null;
    /** `proxmox` = VPS, `discord` = Discord bot, otherwise a game (`minecraft`, ...). */
    service_type?: string | null;
    status?: string | null;
    is_suspended?: boolean;
    is_installing?: boolean;
    node?: string;
    expires_at?: string | null;
    plan?: { name?: string } | null;
    egg_info?: { name?: string } | null;
    limits?: { memory?: number; disk?: number; cpu?: number };
    feature_limits?: { backups?: number };
    connection_addresses?: { primary?: string | null; subdomain?: string | null };
    sftp_details?: { ip?: string; port?: number };
    vps?: {
        ipv4?: string | null;
        username?: string | null;
        os_template?: string | null;
        provision_status?: string | null;
    } | null;
}

/** ResourceUtilizationController (StatsTransformer). */
export interface Resources {
    current_state: string;
    is_suspended?: boolean;
    resources?: {
        memory_bytes?: number;
        cpu_absolute?: number;
        disk_bytes?: number;
        network_rx_bytes?: number;
        network_tx_bytes?: number;
        uptime?: number;
    };
}

/** GET vps/status. */
export interface VpsStatus {
    status?: string;
    provision_status?: string;
    uptime?: number;
    cpu?: number;
    memory?: { used?: number; total?: number };
    ipv4?: string | null;
    username?: string | null;
    os_template?: string | null;
}

/** POST vps/shell. */
export interface VpsShellResponse {
    success?: boolean;
    cwd?: string;
    error?: string;
    agent_required?: boolean;
    result?: {
        exit_code?: number | null;
        stdout?: string;
        stderr?: string;
        timed_out?: boolean;
    };
}

export interface FileObject {
    name: string;
    mode?: string;
    size: number;
    is_file: boolean;
    is_symlink?: boolean;
    mimetype?: string;
    modified_at?: string;
}

export interface Backup {
    uuid: string;
    name: string;
    is_successful: boolean;
    is_locked?: boolean;
    bytes: number;
    created_at: string;
    completed_at: string | null;
}

export interface Account {
    id?: number;
    username?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
}
