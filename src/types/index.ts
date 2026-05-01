export interface Car {
    id: number;
    name: string;
    description: string | null;
    created_at: Date;
}

export interface Media {
    id: number;
    car_id: number;
    file_id: string;
    file_type: 'photo' | 'video';
    caption: string | null;
    created_at: Date;
    ai_description?: string | null;
    ai_tags?: string[] | null;
    ai_colors?: string[] | null;
    ai_material?: string | null;
    ai_style?: string | null;
    ai_analyzed?: boolean;
    ai_placement?: string | null;
}

export interface AdminState {
    mode: 'add_media';
    carId: number;
}

export type FileType = 'photo' | 'video';